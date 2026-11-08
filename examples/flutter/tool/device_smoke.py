#!/usr/bin/env python3
"""设备级 smoke；仅用于本仓库开发验收，需先 npm install 与 flutter pub get。

不安装系统证书。通过本仓库真实 addon、生成的 helper 和临时 smoke target 验证。
运行结束保留 .dart_tool 下日志，恢复示例接入补丁并释放自己创建的转发。
"""
import argparse,sys,os,json,tempfile,socket,subprocess,time,threading,http.server,queue,importlib.util
from pathlib import Path
parser=argparse.ArgumentParser(description='在指定 Flutter 设备上验证真实代理、HTTPS 与生成的 Dio 接入补丁。')
parser.add_argument('--mitmdump', required=True, help='兼容的 mitmdump 可执行文件路径')
parser.add_argument('--android', help='已授权 Android USB 设备 serial')
parser.add_argument('--ios', help='已启动的 iOS 模拟器 UDID')
args=parser.parse_args()
if not args.android and not args.ios:parser.error('至少指定 --android 或 --ios')
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('proxy_control',ROOT/'tests/proxy/test_integration.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
artifact_root=ROOT/'examples/flutter/.dart_tool'
artifact_root.mkdir(parents=True,exist_ok=True)
folder=Path(tempfile.mkdtemp(prefix='api-mocks-device-smoke-',dir=artifact_root))
print('ARTIFACT_DIR',folder,flush=True)
control=m.Control()
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
origin=http.server.ThreadingHTTPServer(('127.0.0.1',0),m.Origin)
threading.Thread(target=origin.serve_forever,daemon=True).start()
log=(folder/'engine.log').open('w')
env=dict(os.environ,API_MOCK_CONTROL_PORT=str(control.port),API_MOCK_CONTROL_TOKEN=control.token,API_MOCK_STORAGE=str(folder/'storage'),API_MOCK_SETTINGS=json.dumps({'maxBodyBytes':1048576,'breakpointTimeout':60}))
engine=subprocess.Popen([str(Path(args.mitmdump).expanduser().resolve()),'-q','-s',str(ROOT/'proxy/addon.py'),'--listen-host','127.0.0.1','--listen-port',str(port),'--set','confdir='+str(folder/'ca'),'--set','connection_strategy=lazy','--set','http2=false','--set','flow_detail=0'],env=env,stdout=log,stderr=subprocess.STDOUT)
example=ROOT/'examples/flutter'
smoke=example/'lib/proxy_smoke.dart'
bundle=folder/'setup.cjs'
setup_applied=False
adb_own=False
smoke_created=False
runners=[]
results=[]
try:
    if not control.connected.wait(45):raise RuntimeError('Engine failed: '+(folder/'engine.log').read_text())
    health=control.rpc('health');print('PROXY',json.dumps(health),flush=True)
    rules=[
      {'id':'device-mock','name':'Device HTTPS mock','enabled':True,'priority':100,'match':{'host':'api-mocks.test','path':'/ping'},'mock':{'status':200,'headers':{'content-type':'application/json'},'body':'{"mocked":true}'},'response':{'headers':{'x-response-modified':'yes'}}},
      {'id':'device-redirect','name':'Device request redirect modify','enabled':True,'priority':100,'match':{'host':'api-mocks.test','path':'/echo'},'request':{'body':'{"modified":true}','headers':{'x-request-modified':'yes','content-type':'application/json'}},'redirect':{'url':'http://127.0.0.1:'+str(origin.server_port)+'/echo'},'response':{'status':202,'headers':{'x-response-modified':'yes'}}},
    ]
    print('SYNC',control.rpc('rules.sync',{'version':1,'rules':rules}),flush=True)
    subprocess.run(['node','-e',"require('esbuild').buildSync({entryPoints:['src/setup.ts'],bundle:true,platform:'node',format:'cjs',outfile:process.argv[1]})",str(bundle)],cwd=ROOT,check=True)
    setup_script="const setup=require(process.argv[1]); const fs=require('fs'); (async()=>{const i=await setup.inspectFlutterProject(process.argv[2]);const c=i.candidates.find(c=>c.automatic);if(!c)throw Error('No automatic Dio candidate');const p=await setup.prepareSetup(i.root,c,fs.readFileSync(process.argv[3],'utf8'));await setup.applySetup(p);console.log('SETUP_APPLIED',p.files.map(f=>f.path));})().catch(e=>{console.error(e);process.exitCode=1});"
    subprocess.run(['node','-e',setup_script,str(bundle),str(example),health['caCertPath']],check=True,cwd=ROOT)
    setup_applied=True
    if smoke.exists():raise RuntimeError('lib/proxy_smoke.dart 已存在，未覆盖用户文件。')
    smoke.write_text('''import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'api_mocks_debug.dart';
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MaterialApp(home: Scaffold(body: Center(child: Text('API Mocks HTTPS smoke')))));
  final dio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 20), receiveTimeout: const Duration(seconds: 30)));
  try {
    await configureApiMocks(dio);
    for (final scheme in ['http','https']) {
      final response = await dio.get<Map<String,dynamic>>('$scheme://api-mocks.test/ping');
      if(response.statusCode != 200 || response.data?['mocked'] != true || response.headers.value('x-response-modified') != 'yes') throw StateError('Mock failed: $scheme ${response.data}');
      debugPrint('API_MOCK_SMOKE_STEP $scheme mock OK');
    }
    final echo = await dio.post<Map<String,dynamic>>('https://api-mocks.test/echo', data: {'original':true}, options: Options(headers:{'authorization':'Bearer SHOULD_NOT_LEAK','cookie':'session=SHOULD_NOT_LEAK'}));
    if(echo.statusCode!=202 || echo.data?['body']!='{"modified":true}' || echo.headers.value('x-response-modified')!='yes') throw StateError('Redirect/request/response modify failed: ${echo.statusCode} ${echo.data}');
    final echoedHeaders = echo.data?['headers'] as Map<String,dynamic>;
    if(echoedHeaders.keys.any((key)=> ['authorization','cookie'].contains(key.toLowerCase()))) throw StateError('Credentials leaked');
    debugPrint('API_MOCK_SMOKE_STEP HTTPS redirect request/response modify credentials OK');
    final upstream = await dio.get<String>('https://example.com/');
    if(upstream.statusCode!=200 || !upstream.data!.contains('Example Domain')) throw StateError('Upstream HTTPS failed: ${upstream.statusCode}');
    debugPrint('API_MOCK_SMOKE_STEP upstream HTTPS OK');
    debugPrint('API_MOCK_SMOKE_OK ${Platform.operatingSystem}');
  } catch(error,stack) {
    debugPrint('API_MOCK_SMOKE_FAILED ${Platform.operatingSystem} $error');
    debugPrint('$stack');
  } finally { dio.close(force:true); }
}
''')
    smoke_created=True
    if args.android:
      mappings=subprocess.run(['adb','-s',args.android,'reverse','--list'],capture_output=True,text=True,check=True).stdout
      existing=[line.split()[-2:] for line in mappings.splitlines() if line.strip()]
      mapped=next((columns[1] for columns in existing if columns[0]=='tcp:'+str(port)),None)
      if mapped is not None and mapped!='tcp:'+str(port):raise RuntimeError('设备端口已有其他转发，未覆盖。')
      if mapped is None:
        subprocess.run(['adb','-s',args.android,'reverse','--no-rebind','tcp:'+str(port),'tcp:'+str(port)],check=True);adb_own=True
    targets=[]
    if args.ios:targets.append((args.ios,'ios-simulator'))
    if args.android:targets.append((args.android,'android-physical'))
    for device,label in targets:
      print('RUNNING',label,flush=True)
      p=subprocess.Popen(['flutter','run','-d',device,'-t','lib/proxy_smoke.dart','--no-pub','--dart-define=API_MOCK_PROXY=127.0.0.1:'+str(port)],cwd=example,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
      runners.append(p)
      lines=queue.Queue()
      def read_lines(process,q):
        for line in process.stdout:q.put(line)
        q.put(None)
      threading.Thread(target=read_lines,args=(p,lines),daemon=True).start()
      deadline=time.time()+600
      output=[];passed=False
      while time.time()<deadline:
        try:line=lines.get(timeout=1)
        except queue.Empty:
          if p.poll() is not None:break
          continue
        if line is None:break
        output.append(line);print(label+': '+line,end='',flush=True)
        if 'API_MOCK_SMOKE_OK' in line:passed=True;break
        if 'API_MOCK_SMOKE_FAILED' in line:break
      (folder/(label+'.log')).write_text(''.join(output))
      results.append({'target':label,'passed':passed})
      try:p.stdin.write('q\n');p.stdin.flush();p.wait(timeout=20)
      except Exception:
        p.terminate()
        try:p.wait(timeout=10)
        except Exception:p.kill()
      print('RESULT',label,passed,flush=True)
    history=control.rpc('history.list',{'limit':50})
    (folder/'history.json').write_text(json.dumps(history,ensure_ascii=False,indent=2))
    (folder/'origin-calls.json').write_text(json.dumps(origin.RequestHandlerClass.calls,ensure_ascii=False,indent=2))
    print('HISTORY_TOTAL',history['total'],flush=True)
    print('RESULTS',json.dumps(results),flush=True)
    (folder/'results.json').write_text(json.dumps(results,indent=2))
finally:
    for p in runners:
      if p.poll() is None:p.terminate()
    if adb_own:subprocess.run(['adb','-s',args.android,'reverse','--remove','tcp:'+str(port)],check=False)
    if smoke_created:smoke.unlink(missing_ok=True)
    if setup_applied:
      subprocess.run(['node','-e',"require(process.argv[1]).revertSetup(process.argv[2]).then(r=>console.log('SETUP_REVERTED',JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})",str(bundle),str(example)],check=False)
    control.close();engine.terminate()
    try:engine.wait(timeout=15)
    except subprocess.TimeoutExpired:engine.kill()
    origin.shutdown();origin.server_close();log.close()

if not results or not all(item['passed'] for item in results):sys.exit(1)

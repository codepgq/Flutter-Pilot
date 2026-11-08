const vscode=require('vscode');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execFile}=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(execFile);
exports.run=async()=>{
 const extension=vscode.extensions.getExtension('api-mocks.flutter-api-mocks');assert.ok(extension,'Extension discovered');await extension.activate();const commands=await vscode.commands.getCommands();for(const c of ['open','start','stop'])assert.ok(commands.includes(`flutterApiMocks.${c}`));
 const storage=process.env.API_MOCK_TEST_STORAGE;
 try{
  await vscode.commands.executeCommand('flutterApiMocks.open');await vscode.commands.executeCommand('flutterApiMocks.start');
  const certificate=path.join(storage,'ca','mitmproxy-ca-cert.pem');await fs.access(certificate);
  const result=await exec('/usr/bin/curl',['--silent','--show-error','--max-time','15','--noproxy','','--proxy','http://127.0.0.1:18080','--cacert',certificate,'https://ide.api-mocks.test/ping']);
  assert.deepEqual(JSON.parse(result.stdout),{ide:true},'IDE-started proxy handles HTTPS mock');
  await new Promise(resolve=>setTimeout(resolve,500));await fs.access(path.join(storage,'history.sqlite3'));
  await vscode.commands.executeCommand('flutterApiMocks.stop');
  await assert.rejects(exec('/usr/bin/curl',['--silent','--show-error','--max-time','2','--noproxy','','--proxy','http://127.0.0.1:18080','http://ide.api-mocks.test/ping']));
  const data=JSON.parse(await fs.readFile(path.join(storage,'rules.json'),'utf8'));assert.equal(data.rules[0].id,'ide-smoke');
  console.log('IDE extension activation, workbench, HTTPS mock, SQLite history, stop listener: PASS');
 }finally{await vscode.commands.executeCommand('workbench.action.closeAllEditors');await extension.exports?.deactivate?.();}
};

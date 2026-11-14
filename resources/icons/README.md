# Flutter Pilot 图标

两枚图标共享深蓝圆角底、蓝青色和向右上方的动势：插件是折纸导航箭头与开放圆环，MCP 是相互连接的链环。图形直接绘制为 SVG，并由同一 SVG 导出 PNG。

| 文件                        | 用途               | 尺寸          |
| --------------------------- | ------------------ | ------------- |
| `plugin.svg` / `plugin.png` | 插件清单、README   | 512 × 512     |
| `mcp.svg` / `mcp.png`       | MCP 服务初始化图标 | 256 × 256     |
| `activity.svg`              | IDE 活动栏         | 24 × 24，单色 |
| `mcp-mono.svg`              | MCP 单色版本       | 24 × 24，单色 |

SVG 是可编辑源文件，无外部字体、图片或网络依赖。PNG 圆角外部透明，图标内部自带深色底，适配深浅主题；小尺寸预览覆盖 16、24、32、64 像素。工作台头部和 MCP 导航使用相同轮廓的内联 SVG，并继承主题颜色。

MCP 使用 `src/mcp/icon-data.ts` 中的 PNG data URI，确保桥接脚本单独复制至用户私有目录后仍可离线返回图标。修改 `mcp.png` 后，在仓库根运行以下命令同步内嵌数据，再运行 `npx prettier --write src/mcp/icon-data.ts`：

```sh
node --input-type=module <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
const data = (await readFile('resources/icons/mcp.png')).toString('base64');
await writeFile('src/mcp/icon-data.ts', `// Generated from resources/icons/mcp.png; kept inline for standalone, offline MCP bridges.\nexport const mcpIcon = {\n  src: 'data:image/png;base64,${data}',\n  mimeType: 'image/png',\n  sizes: ['256x256'],\n};\n`);
NODE
```

`tests/mcp-transport.test.ts` 验证无在线 IDE 时的初始化图标与 PNG 原文件一致。客户端是否展示服务图标由客户端决定。

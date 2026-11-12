#!/usr/bin/env node
// 构建前环境检查：Vite 5 需要 Node >= 18。
// 这个文件本身要能被老版本 Node 跑起来，所以只用 ES5 语法。
var major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  var line = '------------------------------------------------------------';
  console.error('');
  console.error(line);
  console.error('  需要 Node.js >= 18，当前是 ' + process.version);
  console.error('');
  console.error('  修复（本项目已带 .nvmrc）：');
  console.error('    nvm install 18      # 没装过才需要');
  console.error('    nvm use 18');
  console.error('    npm run build');
  console.error('');
  console.error('  想以后默认就是 18：nvm alias default 18');
  console.error(line);
  console.error('');
  process.exit(1);
}

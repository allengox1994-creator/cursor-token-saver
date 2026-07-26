#!/usr/bin/env node
import path from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];

function opt(name, def = null) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
}

const dir = path.resolve(opt('dir', process.cwd()));

const USAGE = `cursor-token-saver <command> [options]

命令:
  init        在目标项目安装 hooks、rule 和 .cursorignore
              --dir <path>       目标项目目录（默认当前目录）
              --profile <name>   激进度档位: conservative | standard | extreme
  dashboard   启动全局 Web 面板（聚合所有已登记项目，可切到单项目看明细/改配置）
              --port <n>         端口（默认 4517）
  report      在终端打印统计报表
              --all              全局汇总（所有已登记项目）
              --dir <path>       单项目报表（默认当前目录）
  index       预建语义搜索的神经嵌入索引（首次下载模型约 25MB）
              --dir <path>       目标项目目录（默认当前目录）
  daemon      启动全局嵌入/索引推理服务（所有项目共享一个模型实例）
              --port <n>         仅监听 127.0.0.1，默认 4518
  start-all   一键后台启动面板、前端和全局索引服务（可重复执行）
              --dashboard-port <n> 面板端口（默认 4517）
              --daemon-port <n>    索引服务端口（默认 4518）
  eval        离线评测当前项目检索质量并写入 eval-report.json
              --dir <path>       目标项目目录（默认当前目录）
              --limit <n>        最大评测查询数（默认 50）
              --auto             内部后台模式（带锁与状态记录）
  bench       在当前项目上跑省 token 基准测试（真实文件、诚实口径）
              --dir <path>       目标项目目录（默认当前目录）
              --max-files <n>    采样的最大源文件数（默认 8）
  license     授权管理（Ed25519 离线校验，无需联网）
              activate <key>     激活授权
              status             查看当前授权
              deactivate         移除本机授权
              issue              签发授权（供应商侧，需要私钥）
                --email <addr> --plan pro|team --days <n> --seats <n>
                --private <pem>  私钥路径（默认 ~/.cursor-token-saver/vendor-private.pem）
`;

switch (cmd) {
  case 'init': {
    const { install } = await import('../src/init/install.mjs');
    install(dir, { profile: opt('profile') });
    break;
  }
  case 'dashboard': {
    const { start } = await import('../src/dashboard/server.mjs');
    start(dir, Number(opt('port', '4517')));
    break;
  }
  case 'report': {
    const { report, reportAll } = await import('../src/report.mjs');
    if (args.includes('--all')) reportAll();
    else report(dir);
    break;
  }
  case 'index': {
    const { buildCmd } = await import('../src/embed/build-cmd.mjs');
    await buildCmd(dir);
    break;
  }
  case 'daemon': {
    const { startDaemon } = await import('../src/embed/daemon-server.mjs');
    const server = startDaemon(Number(opt('port', '4518')));
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') process.exit(0);
      throw e;
    });
    break;
  }
  case 'start-all': {
    const { startAllCmd } = await import('../src/start-all.mjs');
    await startAllCmd({
      dashboardPort: Number(opt('dashboard-port', '4517')),
      daemonPort: Number(opt('daemon-port', '4518'))
    });
    break;
  }
  case 'eval': {
    const { runRetrievalEval } = await import('../src/eval/retrieval-eval.mjs');
    await runRetrievalEval(dir, { limit: Number(opt('limit', '50')), auto: args.includes('--auto') });
    break;
  }
  case 'bench': {
    const { runBench, printBench } = await import('../src/bench/bench.mjs');
    printBench(runBench(dir, { maxFiles: Number(opt('max-files', '8')) }));
    break;
  }
  case 'license': {
    const sub = args[1];
    const lic = await import('../src/license/license.mjs');
    if (sub === 'activate') {
      const res = lic.activateLicense(args[2]);
      if (!res.valid) {
        console.error(`授权无效: ${res.reason}`);
        process.exit(1);
      }
      console.log(`已激活 ${res.payload.plan} 授权（${res.payload.email}），有效期至 ${res.payload.exp ? new Date(res.payload.exp).toISOString().slice(0, 10) : '永久'}`);
    } else if (sub === 'status') {
      console.log(JSON.stringify(lic.licenseStatus(), null, 2));
    } else if (sub === 'deactivate') {
      lic.deactivateLicense();
      console.log('已移除本机授权');
    } else if (sub === 'issue') {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const privPath = opt('private', path.join(os.homedir(), '.cursor-token-saver', 'vendor-private.pem'));
      let privateKeyPem;
      try {
        privateKeyPem = fs.readFileSync(privPath, 'utf8');
      } catch {
        console.error(`读不到私钥: ${privPath}（先运行一次密钥生成，或用 --private 指定路径）`);
        process.exit(1);
      }
      const res = lic.issueLicense(
        { email: opt('email'), plan: opt('plan', 'pro'), days: Number(opt('days', '365')), seats: Number(opt('seats', '1')) },
        privateKeyPem
      );
      if (res.error) {
        console.error(`签发失败: ${res.error}`);
        process.exit(1);
      }
      console.log(res.key);
    } else {
      console.error('用法: cursor-token-saver license <activate|status|deactivate|issue>');
      process.exit(1);
    }
    break;
  }
  default:
    process.stdout.write(USAGE);
    process.exit(cmd ? 1 : 0);
}

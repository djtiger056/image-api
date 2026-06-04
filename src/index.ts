"use strict";

import environment from "@/lib/environment.ts";
import config from "@/lib/config.ts";
import "@/lib/initialize.ts";
import server from "@/lib/server.ts";
import routes from "@/api/routes/index.ts";
import logger from "@/lib/logger.ts";
import accountManager from "@/lib/account-manager.ts";
import { browserSigner } from "@/lib/browser-signer.ts";

const startupTime = performance.now();

(async () => {
  logger.header();

  logger.info("<<<< images-api: 多平台兼容逆向 API 统一生图平台 >>>>");
  logger.info("Version:", environment.package.version);
  logger.info("Process id:", process.pid);
  logger.info("Environment:", environment.env);
  logger.info("Service name:", config.service.name);

  // 初始化账号管理器
  accountManager.init();

  server.attachRoutes(routes);
  await server.listen();

  config.service.bindAddress &&
    logger.success("Service bind address:", config.service.bindAddress);

  // 异步启动浏览器签名服务（不阻塞服务器启动）
  browserSigner.start().catch((err) => {
    logger.error(`[BrowserSigner] 启动失败（不影响基础功能）: ${err.message}`);
  });
})()
  .then(() =>
    logger.success(
      `Service startup completed (${Math.floor(performance.now() - startupTime)}ms)`
    )
  )
  .catch((err) => console.error(err));
// trigger rebuild

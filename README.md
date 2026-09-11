# 机坪航空器拖行资料服务

仓库保存一组有向机坪路段、共享交叉区、机型限制和拖行申请。`fixtures/context.json` 中每条边给出标准通过秒数，交叉区安全间隔独立于路段占用，时间采用机场本地偏移量。

Node.js 20 以上版本运行 `npm test` 与 `npm start`。健康检查位于 `GET /health`，也可用 `docker compose up --build` 运行容器。实际机坪地图、无线电记录和人员资质凭据不纳入仓库。

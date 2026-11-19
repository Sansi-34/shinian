// 阶段回顾路由入口。
// 实现位于 reviewData.ts（数据层与路由共用同一组契约函数），这里保持稳定的注册入口，
// 供 src/server/index.ts 直接 import { registerReviewRoutes } from './reviewRoutes'。
export { registerReviewRoutes } from './reviewData';

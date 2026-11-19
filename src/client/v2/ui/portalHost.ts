// 弹层 portal 目标：必须留在 .v2-root 里。
// 颜色 token（--raise / --ink / --accent-ink / --line）只在 .v2-root 上定义，
// portal 到 document.body 会让这些变量全部失效 —— 面板变透明、文字与背景同色、
// 主按钮文字看不见。这里统一取 .v2-root，取不到才退回 body。
export function v2PortalHost(): HTMLElement {
  return (document.querySelector('.v2-root') as HTMLElement | null) ?? document.body;
}

// CSS Modules 类型声明：V2 组件层用 *.module.css，类名由 Vite 生成
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

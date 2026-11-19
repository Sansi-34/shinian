// 拾念 SHINIAN v0.1 - 入口
import { createRoot } from 'react-dom/client';
import App from './App';
import './gz-tokens.css';
import './styles.css';
import './gz-pages.css';
import './experience-notes.css';
import './home-first-screen.css';
// 动效层放最后：需要覆盖各页面自己的 keyframes（入场编排 / 图谱动效）
import './ui-motion.css';
import './graph-motion.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
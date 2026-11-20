// macOS 暗色动态壁纸层：两幅高精度丝绸流体曲线壁纸柔和交叉淡化，无杂噪微粒
// 开启「减少动态效果」时保持静止画面；纸张主题下自动停用。
import { useEffect, useState } from 'react';
import wallA from '../../assets/macos-wall-a.jpg';
import wallB from '../../assets/macos-wall-b.jpg';
import styles from './CosmosBackdrop.module.css';

export default function CosmosBackdrop({ active = true }: { active?: boolean }) {
  const [scene, setScene] = useState<0 | 1>(0);

  useEffect(() => {
    if (!active) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduce) {
      setScene(0);
      return;
    }
    const id = window.setInterval(() => {
      setScene((s) => (s === 0 ? 1 : 0));
    }, 18000);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;

  return (
    <div className={styles.stage} aria-hidden="true">
      <div
        className={`${styles.layer} ${styles.driftA}${scene === 0 ? ' ' + styles.visible : ''}`}
        style={{ backgroundImage: `url(${wallA})` }}
      />
      <div
        className={`${styles.layer} ${styles.driftB}${scene === 1 ? ' ' + styles.visible : ''}`}
        style={{ backgroundImage: `url(${wallB})` }}
      />
      <div className={styles.vignette} />
    </div>
  );
}

// 加载指示器
// 灵感来自 UI Moments 收录的 SVG Spinners（Utkarsh Verma, MIT）与 LDRS（Griffin Johnston, MIT）；
// 这里按拾念的 token 重画，不引入第三方包。
import styles from './Spinner.module.css';

export default function Spinner({
  size = 14,
  label = '加载中',
  hideLabel = false,
}: {
  size?: number;
  label?: string;
  hideLabel?: boolean;
}) {
  return (
    <span className={styles.wrap} role="status" aria-label={label}>
      <svg width={size} height={size} viewBox="0 0 24 24" className={styles.svg} aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="14 46"
          className={styles.arc}
        />
      </svg>
      {!hideLabel && <span className={styles.text}>{label}</span>}
    </span>
  );
}

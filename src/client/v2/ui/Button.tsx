import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'ghost';

export default function Button({
  variant = 'ghost',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={`${styles.btn} ${styles[variant]}${className ? ' ' + className : ''}`} {...rest} />;
}

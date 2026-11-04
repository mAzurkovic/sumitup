import logo from '@/assets/logo.svg';
import type { ReactNode } from 'react';

export function Header({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <header>
      <div className="header">
        <span className="brand">
          <img src={logo} width={20} height={20} alt="" />
          Sum it up!
        </span>
        <button type="button" className="chevron" aria-label="Close panel" onClick={onClose}>
          ›
        </button>
      </div>
      <h1 className="title">{title}</h1>
      {children}
    </header>
  );
}

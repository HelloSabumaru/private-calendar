import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Dialog({ title, actions, closeLabel = 'Close dialog', onClose, children }: { title: string; actions?: ReactNode; closeLabel?: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header"><button type="button" className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><Icon name="left" /></button><h2 id={titleId}>{title}</h2><div className="dialog-header-actions">{actions}</div></div>
    <div className="dialog-body">{children}</div>
  </dialog>;
}

import type { ComponentPropsWithoutRef, ElementType } from 'react';

type Props<T extends ElementType> = {
  as?: T;
  /** Denser fill for panels that sit over busy content (topbar, toasts). */
  strong?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, 'as'>;

/** Translucent chrome surface (nav, toolbars, floating panels, modals). Never for tables or data. */
export function GlassPanel<T extends ElementType = 'div'>({ as, strong, className, ...rest }: Props<T>) {
  const Tag: ElementType = as ?? 'div';
  return <Tag className={['glass', strong ? 'glass-strong' : '', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

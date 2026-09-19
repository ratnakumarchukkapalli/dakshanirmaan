import type { ComponentPropsWithoutRef } from 'react';

/** Near-opaque content card: the resting surface for data. */
export function Card({ className, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return <div className={['card', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

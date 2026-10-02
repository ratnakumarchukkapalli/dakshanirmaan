/** 200000 -> "200,000" for a plain-language message (a count, not money). */
export const formatThousands = (n: number): string => new Intl.NumberFormat('en-IN').format(n);

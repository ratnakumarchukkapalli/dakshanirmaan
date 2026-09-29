// A route parameter that is not a real UUID must be a 404, not a database error (Postgres answers
// 22P02 for a malformed uuid, which would surface as a 500).
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_PATTERN.test(v);

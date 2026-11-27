// Cards and assignments are listed ordered by createdAt alone; rows that share a timestamp order
// arbitrarily. One millisecond per seeded row, keyed by the seed object, keeps the order total and
// identical on both sides (the harness seeds each side with a fresh object).
import type { Seeded } from "./contract.mts";

const OLD = new Date(Date.UTC(2022, 4, 1));

const seedTimes = new WeakMap<Seeded, number>();
export const seedTime = (seeded: Seeded) => {
  const n = seedTimes.get(seeded) ?? 0;
  seedTimes.set(seeded, n + 1);
  return new Date(OLD.getTime() + n);
};

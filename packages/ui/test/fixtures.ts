import { makeTitleCard, resetFixtures } from "@webflix/contracts/fixtures";

export function titleCards(count: number) {
  resetFixtures();
  return Array.from({ length: count }, (_, index) =>
    makeTitleCard({ id: `t-test-${index + 1}`, name: `Title ${index + 1}` }),
  );
}

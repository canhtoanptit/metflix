/**
 * The part of a client address that identifies one subscriber, for rate limits: an IPv4 address
 * as is, an IPv6 address by its /64 prefix. A home or mobile subscriber gets at least a /64 and
 * can pick any address in it, so limiting per full IPv6 address would limit nothing.
 * IPv4-mapped IPv6 addresses (`::ffff:192.0.2.1`) count as the IPv4 address they carry.
 * Anything that does not parse is returned as is (it is still a stable key).
 */
export function clientAddressKey(address: string): string {
  if (!address.includes(":")) return address;
  const groups = ipv6Groups(address.split("%")[0] ?? "");
  if (!groups) return address.toLowerCase();
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === "") return [];
    const groups: number[] = [];
    const parts = half.split(":");
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const octets = part.split(".");
        if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet))) return null;
        const [a, b, c, d] = octets.map(Number) as [number, number, number, number];
        if ([a, b, c, d].some((octet) => octet > 255)) return null;
        groups.push((a << 8) | b, (c << 8) | d);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

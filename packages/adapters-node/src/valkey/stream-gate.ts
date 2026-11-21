import {
  type AcquireStreamResult,
  assertAcquireRequest,
  assertLeaseTtl,
  type Clock,
  type StreamGate,
  type StreamLease,
} from "@webflix/core";
import { LUA_NOW, LuaScript, type ValkeyConnection } from "./connection.ts";

/**
 * `StreamGate` on Valkey: one hash per account (`field = playbackSessionId`, value = lease
 * JSON, plus a `#seq` counter that orders leases acquired in the same millisecond). Every
 * operation is one Lua script, so the read-check-write of an acquire is atomic per account
 * exactly like a Durable Object: two replicas starting streams for the same account at the
 * same instant can never exceed the plan's limit. Times come from Valkey's clock.
 *
 * Timestamps are epoch milliseconds (13 digits), within cjson's 14 significant digits.
 */
const PRELUDE = `${LUA_NOW}
local function load_live(key, now)
  local live = {}
  local expired = {}
  local all = redis.call('HGETALL', key)
  for i = 1, #all, 2 do
    local field = all[i]
    if field ~= '#seq' then
      local lease = cjson.decode(all[i + 1])
      if lease.expiresAt <= now then
        table.insert(expired, field)
      else
        live[field] = lease
      end
    end
  end
  return live, expired
end

local function save(key, live, now)
  local latest = 0
  local count = 0
  for _, lease in pairs(live) do
    count = count + 1
    if lease.expiresAt > latest then latest = lease.expiresAt end
  end
  if count == 0 then
    redis.call('DEL', key)
  else
    -- Garbage collection only (correctness never relies on it): keep the hash a minute past
    -- the last lease's expiry.
    redis.call('PEXPIRE', key, math.max(1, latest - now) + 60000)
  end
end
`;

const ACQUIRE = new LuaScript(`${PRELUDE}
local key = KEYS[1]
local now = now_ms(ARGV[4])
local request = cjson.decode(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local live, expired = load_live(key, now)
if #expired > 0 then redis.call('HDEL', key, unpack(expired)) end

local existing = live[request.playbackSessionId]
if existing then
  existing.renewedAt = now
  existing.expiresAt = now + ttl
  local encoded = cjson.encode(existing)
  redis.call('HSET', key, request.playbackSessionId, encoded)
  save(key, live, now)
  return {'ok', encoded, ''}
end

local same_device = nil
local count = 0
for id, lease in pairs(live) do
  count = count + 1
  if lease.deviceId == request.deviceId then same_device = id end
end
local others = count
if same_device then others = count - 1 end
if others >= limit then
  local reply = {'full'}
  for _, lease in pairs(live) do table.insert(reply, cjson.encode(lease)) end
  save(key, live, now)
  return reply
end
if same_device then
  redis.call('HDEL', key, same_device)
  live[same_device] = nil
end
request.acquiredAt = now
request.renewedAt = now
request.expiresAt = now + ttl
request.seq = redis.call('HINCRBY', key, '#seq', 1)
local encoded = cjson.encode(request)
redis.call('HSET', key, request.playbackSessionId, encoded)
live[request.playbackSessionId] = request
save(key, live, now)
return {'ok', encoded, same_device or ''}
`);

const RENEW = new LuaScript(`${PRELUDE}
local key = KEYS[1]
local now = now_ms(ARGV[3])
local live, expired = load_live(key, now)
if #expired > 0 then redis.call('HDEL', key, unpack(expired)) end
local lease = live[ARGV[1]]
if not lease then
  save(key, live, now)
  return false
end
lease.renewedAt = now
lease.expiresAt = now + tonumber(ARGV[2])
local encoded = cjson.encode(lease)
redis.call('HSET', key, ARGV[1], encoded)
save(key, live, now)
return encoded
`);

const RELEASE_DEVICE = new LuaScript(`
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  if all[i] ~= '#seq' and cjson.decode(all[i + 1]).deviceId == ARGV[1] then
    redis.call('HDEL', KEYS[1], all[i])
  end
end
return 1
`);

// Read-only: filters expired leases without deleting them, so a listing never writes.
const LIST = new LuaScript(`${LUA_NOW}
local now = now_ms(ARGV[1])
local reply = {}
local all = redis.call('HGETALL', KEYS[1])
for i = 1, #all, 2 do
  if all[i] ~= '#seq' then
    local lease = cjson.decode(all[i + 1])
    if lease.expiresAt > now then table.insert(reply, all[i + 1]) end
  end
end
return reply
`);

interface StoredLease extends StreamLease {
  seq: number;
}

function decode(encoded: string): StoredLease {
  const raw = JSON.parse(encoded) as StoredLease;
  return { ...raw, titleName: raw.titleName ?? null };
}

function toLease({ seq: _seq, ...lease }: StoredLease): StreamLease {
  return lease;
}

const oldestFirst = (a: StoredLease, b: StoredLease) =>
  a.acquiredAt - b.acquiredAt || a.seq - b.seq;

export interface ValkeyStreamGateOptions {
  /** Tests only: read time from this clock instead of Valkey's `TIME`. */
  clock?: Clock;
}

export function createValkeyStreamGate(
  valkey: ValkeyConnection,
  options: ValkeyStreamGateOptions = {},
): StreamGate {
  const { client } = valkey;
  // The hash tag keeps an account's keys in one slot should this ever run on Valkey Cluster.
  const keyOf = (accountId: string) => `${valkey.keyPrefix}streams:{${accountId}}`;
  const now = () => (options.clock ? String(options.clock.now()) : "");

  return {
    async acquire(request): Promise<AcquireStreamResult> {
      assertAcquireRequest(request);
      const payload = JSON.stringify({
        accountId: request.accountId,
        playbackSessionId: request.playbackSessionId,
        deviceId: request.deviceId,
        deviceLabel: request.deviceLabel,
        titleName: request.titleName,
      });
      const reply = (await valkey.guard("stream_gate.acquire", () =>
        ACQUIRE.run(
          client,
          [keyOf(request.accountId)],
          [payload, request.limit, request.leaseTtlSec * 1000, now()],
        ),
      )) as string[];
      const [status, ...rest] = reply;
      if (status === "ok") {
        const [encoded = "", replaced = ""] = rest;
        return { ok: true, lease: toLease(decode(encoded)), replaced: replaced || null };
      }
      return { ok: false, active: rest.map(decode).sort(oldestFirst).map(toLease) };
    },

    async renew(accountId, playbackSessionId, leaseTtlSec) {
      assertLeaseTtl(leaseTtlSec);
      const encoded = (await valkey.guard("stream_gate.renew", () =>
        RENEW.run(client, [keyOf(accountId)], [playbackSessionId, leaseTtlSec * 1000, now()]),
      )) as string | null;
      return encoded ? toLease(decode(encoded)) : null;
    },

    async release(accountId, playbackSessionId) {
      await valkey.guard("stream_gate.release", () =>
        client.hdel(keyOf(accountId), playbackSessionId),
      );
    },

    async releaseDevice(accountId, deviceId) {
      await valkey.guard("stream_gate.release_device", () =>
        RELEASE_DEVICE.run(client, [keyOf(accountId)], [deviceId]),
      );
    },

    async releaseAll(accountId) {
      await valkey.guard("stream_gate.release_all", () => client.del(keyOf(accountId)));
    },

    async list(accountId) {
      const encoded = (await valkey.guard("stream_gate.list", () =>
        LIST.run(client, [keyOf(accountId)], [now()]),
      )) as string[];
      return encoded.map(decode).sort(oldestFirst).map(toLease);
    },
  };
}

import {
  ChannelService,
  Customer,
  ID,
  Logger,
  RequestContext,
} from '@vendure/core';
import { DEFAULT_CHANNEL_CODE } from '@vendure/common/lib/shared-constants';

const loggerCtx = 'BrandChannelSync';

/**
 * Resolves which channel ids a customer should have after shop login.
 * Always includes the default channel (e.g. __default_channel__) plus the
 * channel the request hit (vendure-token). City logins do not fan out to
 * sibling channels — only default + current.
 */
export async function resolveBrandChannelIds(
  ctx: RequestContext,
  channelService: ChannelService,
): Promise<ID[]> {
  // Do not use channelService.getDefaultChannel(): it reads the in-memory
  // `allChannels` cache populated only by initChannels() at bootstrap. The
  // ChannelService instance resolved inside an AuthenticationStrategy has an
  // uninitialized cache, so that call throws "Cannot read properties of
  // undefined (reading 'value')". findAll() goes through the query builder
  // and has no such dependency.
  const defaultChannelResult = await channelService.findAll(ctx, {
    filter: { code: { eq: DEFAULT_CHANNEL_CODE } },
  });
  const defaultChannel = defaultChannelResult.items[0];
  const ids = new Set<ID>();
  if (defaultChannel) {
    ids.add(defaultChannel.id);
  }
  ids.add(ctx.channelId);
  const result = Array.from(ids);
  Logger.info(
    `channelToken="${ctx.channel.token}" ctx.channelId=${ctx.channelId} defaultChannelId=${defaultChannel?.id} targetChannelIds=[${result.join(',')}]`,
    loggerCtx,
  );
  return result;
}

/**
 * Additive channel sync: append [defaultChannel, currentChannel] to the
 * customer's existing channel memberships. Never prunes — channels the
 * customer joined in earlier logins (other cities, brands) are preserved,
 * so a user can accumulate access across the channels they actually visit.
 * Implemented here (not via assignToCurrentChannel) because that core method
 * internally calls getDefaultChannel(), whose bootstrap-only `allChannels`
 * cache is uninitialized on the ChannelService instance an
 * AuthenticationStrategy resolves — see resolveBrandChannelIds above.
 */
export async function syncCustomerChannelsOnLogin(
  channelService: ChannelService,
  ctx: RequestContext,
  customerId: ID,
  targetChannelIds: ID[],
): Promise<void> {
  if (targetChannelIds.length === 0) {
    return;
  }

  await channelService.assignToChannels(ctx, Customer, customerId, targetChannelIds);
}

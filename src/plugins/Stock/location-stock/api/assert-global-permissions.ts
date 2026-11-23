import { ForbiddenError, Permission, RequestContext } from '@vendure/core';

/**
 * Enforce that the current admin holds EVERY listed permission on AT LEAST ONE
 * of their channels (channel-agnostic / global). The location-stock tools scope
 * data by stock location + product tag, never by channel, so permission is
 * checked globally rather than against ctx.channelId (which the @Allow guard
 * uses). SuperAdmin on any channel satisfies every check.
 */
export function assertGlobalPermissions(ctx: RequestContext, permissions: Permission[]): void {
    const channels = ctx.session?.user?.channelPermissions ?? [];
    const hasGlobally = (permission: Permission): boolean =>
        channels.some(
            channel =>
                channel.permissions.includes(Permission.SuperAdmin) ||
                channel.permissions.includes(permission),
        );
    const missing = permissions.filter(permission => !hasGlobally(permission));
    if (missing.length > 0) {
        throw new ForbiddenError();
    }
}

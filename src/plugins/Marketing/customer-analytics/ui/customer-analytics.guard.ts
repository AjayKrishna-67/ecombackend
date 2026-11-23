import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { PermissionsService } from '@vendure/admin-ui/core';

/**
 * Permissions accepted to view the Customer Analytics page. SuperAdmin is an
 * explicit fallback so the owner is never locked out before the custom
 * ReadCustomerAnalytics permission is assigned to a role (mirrors the resolver
 * @Allow and the React dashboard's nav gate). userHasPermissions is OR semantics.
 */
const REQUIRED_PERMISSIONS: readonly string[] = ['ReadCustomerAnalytics', 'SuperAdmin'];

/**
 * Route hard-gate: blocks the page shell for roles lacking ReadCustomerAnalytics
 * on a deep-link, redirecting to the dashboard root instead of rendering an empty
 * shell whose queries 403. The nav link is already hidden by requiresPermission and
 * the data is already safe via the resolver @Allow; this is the deep-link polish.
 * admin-ui ships no built-in permission route guard (AuthGuard is login-only), so
 * this is hand-rolled and wired via routes.ts routeConfig.canActivate.
 */
export const customerAnalyticsGuard: CanActivateFn = (): boolean | UrlTree => {
    const permissionsService = inject(PermissionsService);
    const router = inject(Router);
    if (permissionsService.userHasPermissions([...REQUIRED_PERMISSIONS])) {
        return true;
    }
    return router.parseUrl('/');
};

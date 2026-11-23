import { addNavMenuItem } from '@vendure/admin-ui/core';

/**
 * Nav entry under Settings.
 *
 * `requiresPermission: 'SuperAdmin'` matches the resolver exactly -- every
 * query and mutation on this API is `@Allow(Permission.SuperAdmin)` and the
 * plugin defines no CrudPermissionDefinition of its own. Anything looser would
 * put a menu item in front of admins whose first click 403s.
 */
export default [
    addNavMenuItem(
        {
            id: 'scheduled-availability',
            label: 'Scheduled Availability',
            routerLink: ['/extensions/scheduled-availability'],
            icon: 'clock',
            requiresPermission: 'SuperAdmin',
        },
        'settings',
    ),
];

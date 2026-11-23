import { PermissionDefinition } from '@vendure/core';

export const readShiprocketSettingsPermission = new PermissionDefinition({
    name: 'ReadShiprocketSettings',
    description: 'Allows reading Shiprocket international shipping settings',
});

export const updateShiprocketSettingsPermission = new PermissionDefinition({
    name: 'UpdateShiprocketSettings',
    description: 'Allows editing Shiprocket international shipping settings',
});

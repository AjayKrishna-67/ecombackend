import { PermissionDefinition } from '@vendure/core';

export const referralRewardsPermission = new PermissionDefinition({
    name: 'ReferralRewards',
    description: 'Allows viewing and managing referral rewards configurations',
});

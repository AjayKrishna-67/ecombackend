import { graphql } from '@vendure/dashboard';

export const customerSegmentSummaryDocument = graphql(`
    query CustomerSegmentSummary {
        customerSegmentSummary {
            active
            atRisk
            churn
            never
            savedStates
            config {
                activeWithinDays
                atRiskUntilDays
            }
        }
    }
`);

export const customerSegmentListDocument = graphql(`
    query CustomerSegmentList($state: CustomerSegmentState!, $options: CustomerSegmentListOptions) {
        customerSegmentList(state: $state, options: $options) {
            totalItems
            items {
                customerId
                firstName
                lastName
                emailAddress
                lastOrderAt
                daysSinceLastOrder
                state
            }
        }
    }
`);

export const customerSegmentExportDocument = graphql(`
    query CustomerSegmentExport($state: CustomerSegmentState!) {
        customerSegmentExport(state: $state) {
            customerId
            firstName
            lastName
            emailAddress
            phoneNumber
            orderCount
            totalOrderValue
            lastOrderAt
            state
        }
    }
`);

export const saveCustomerSegmentAsGroupDocument = graphql(`
    mutation SaveCustomerSegmentAsGroup($state: CustomerSegmentState!, $groupName: String) {
        saveCustomerSegmentAsGroup(state: $state, groupName: $groupName) {
            id
            name
        }
    }
`);

export const setRecencyThresholdsDocument = graphql(`
    mutation SetRecencyThresholds($activeWithinDays: Int!, $atRiskUntilDays: Int!) {
        setRecencyThresholds(activeWithinDays: $activeWithinDays, atRiskUntilDays: $atRiskUntilDays) {
            activeWithinDays
            atRiskUntilDays
        }
    }
`);

export const abandonedCartSettingsDocument = graphql(`
    query AbandonedCartSettings {
        abandonedCartSettings {
            enabled
            minOrderValueMinor
            costPerMessageMinor
            stages { delayValue delayUnit templateName language headerImageUrl buttonUrlParam bodyVars { kind value } }
        }
        abandonedCartEligiblePreview
    }
`);

export const setAbandonedCartSettingsDocument = graphql(`
    mutation SetAbandonedCartSettings($input: AbandonedCartSettingsInput!) {
        setAbandonedCartSettings(input: $input) {
            enabled
            minOrderValueMinor
            costPerMessageMinor
            stages { delayValue delayUnit templateName language headerImageUrl buttonUrlParam bodyVars { kind value } }
        }
    }
`);

export const abandonedCartAnalyticsDocument = graphql(`
    query AbandonedCartAnalytics {
        abandonedCartAnalytics {
            totalSent
            sentByStage { stage count }
            conversions
            conversionsByStage { stage count }
            conversionRate
            avgTimeToOrderSeconds
            revenueRecoveredMinor
            totalCostMinor
            roi
        }
    }
`);

/**
 * Admin-editable recipients for the order-cancellation WhatsApp alert.
 * Stored as a single JSON object in the SettingsStore under the keys in ./constants.ts.
 */
export interface CancelOrderAlertConfig {
    /** MSG91 "Hello" integrated number the alert is sent FROM (digits, with country code). */
    helloNumber: string;
    /** Ad-hoc numbers the alert is sent TO (digits, with country code). */
    supportNumbers: string[];
    /**
     * Administrators the alert is sent TO. Stored as ids, not numbers, so an admin who
     * updates their phone number keeps receiving alerts without anyone re-editing this.
     */
    adminIds: string[];
}

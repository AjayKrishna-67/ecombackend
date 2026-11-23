import { Link, useNavigate } from '@tanstack/react-router';
import {
    Button,
    Page,
    PageActionBar,
    PageActionBarRight,
    PageBlock,
    PageLayout,
    PageTitle,
} from '@vendure/dashboard';
import React from 'react';
import { ScheduleFormFields } from './schedule-form-fields';
import { useScheduleForm } from './use-schedule-form';

/**
 * Creating a schedule, as a page rather than a dialog.
 *
 * Matches how the dashboard creates every other entity: `/products/new`,
 * `/collections/new`. The route is the existing `/availability-schedules/$id`
 * with `id === 'new'` -- the same trick core uses, which avoids a second route
 * and any question of which one wins the match.
 */
export function AvailabilityScheduleNewPage() {
    const navigate = useNavigate();

    const { form, setForm, occurrences, previewError, noPatternChosen, canSave, save } =
        useScheduleForm({
            editing: null,
            isActive: true,
            onSaved: scheduleId => {
                // Straight to the new rule's detail page, so the admin lands on
                // its run history rather than back at an unchanged list.
                // Interpolated path rather than `to: '$id'` + `params`: extension
                // routes are not part of the registered TanStack route tree, so
                // the typed-params form does not resolve and every call site in
                // this project that uses it carries a type error.
                void navigate({ to: `/availability-schedules/${scheduleId}` });
            },
        });

    // Spread into every block: the groups share one form state, so the props
    // must stay identical across them or a field would write to a stale copy.
    const fieldProps = { form, setForm, occurrences, previewError, noPatternChosen };

    return (
        <Page pageId="availability-schedule-new">
            <PageTitle>New schedule</PageTitle>

            <PageActionBar>
                <PageActionBarRight>
                    <Button variant="outline" render={<Link to="/availability-schedules" />}>
                        Cancel
                    </Button>
                    <Button disabled={!canSave} onClick={() => save.mutate()}>
                        Create schedule
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <PageLayout>
                {/* One block per group, mirroring the Product and Order detail
                    screens. Grouping is not decoration here: it is what lets an
                    admin answer "what does this send, and when" without reading
                    every field on the page. */}
                <PageBlock column="main" blockId="what-to-schedule">
                    <ScheduleFormFields {...fieldProps} section="what" />
                </PageBlock>

                <PageBlock column="main" blockId="recipients">
                    <ScheduleFormFields {...fieldProps} section="recipients" />
                </PageBlock>

                <PageBlock column="main" blockId="when-it-runs">
                    <ScheduleFormFields {...fieldProps} section="when" />
                </PageBlock>

                <PageBlock column="main" blockId="preview" title="What will happen">
                    <ScheduleFormFields {...fieldProps} section="preview" />
                </PageBlock>

                {/* Side, like Product's Tags and Channels: identifying metadata
                    rather than part of what the rule does. */}
                <PageBlock column="side" blockId="details" title="Details">
                    <ScheduleFormFields {...fieldProps} section="details" />
                </PageBlock>
            </PageLayout>
        </Page>
    );
}

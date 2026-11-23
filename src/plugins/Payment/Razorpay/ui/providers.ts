import { DATE_PIPE_DEFAULT_OPTIONS } from '@angular/common';
import {
  addActionBarItem,
  ModalService,
  registerFormInputComponent,
  registerHistoryEntryComponent,
  registerAlert,
  Permission
} from '@vendure/admin-ui/core';
import { RazorpayStatusDialogComponent } from './razorpay-status-dialog.component';
import { RazorpayPaymentConfigComponent } from './razorpay-payment-config.component';
import { PaymentWindowStatusComponent } from './payment-window-status.component';
import { map } from 'rxjs/operators';
import { RazorpayWebhookHistoryComponent } from './razorpay-webhook-history.component';
import { interval } from 'rxjs';
import gql from 'graphql-tag';
import { Router } from '@angular/router';

interface RazorpayAlert {
  orderId: string;
  orderCode: string;
  reason: string;
  stuckSince: string;
}

const GET_RAZORPAY_ALERTS = gql`
  query GetRazorpayAlerts {
    getRazorpayAlerts {
      orderId
      orderCode
      reason
      stuckSince
    }
  }
`;

export default [
  // Global timezone configuration for IST (India Standard Time)
  // This ensures all date pipes display times in the correct timezone
  {
    provide: DATE_PIPE_DEFAULT_OPTIONS,
    useValue: { timezone: 'Asia/Kolkata' }
  },
  // Register custom payment config form component
  registerFormInputComponent('razorpay-payment-config', RazorpayPaymentConfigComponent),

  // Register payment window status component
  registerFormInputComponent('payment-window-status', PaymentWindowStatusComponent),
  

  registerHistoryEntryComponent({
    type: 'RAZORPAY_WEBHOOK',
    component: RazorpayWebhookHistoryComponent,
  }),
  // Action bar item for payment status
  addActionBarItem({
      id: 'view-razorpay-status',
      label: 'Razorpay Status',
      locationId: 'order-detail',
      icon: 'credit-card',
      buttonState: (context) => {
          return context.entity$.pipe(
              map((order: any) => {
                  if (!order) {
                      return { visible: false, disabled: false };
                  }
                  
                  // Primary check: Must have razorpayOrderId in customFields
                  const hasRazorpayOrderId = order.customFields?.razorpayOrderId;
                  
                  if (!hasRazorpayOrderId) {
                      console.log('Hiding button: No Razorpay Order ID found');
                      return { visible: false, disabled: false };
                  }
                  
                  // Secondary check: If payments exist, verify not offline
                  if (order.payments && order.payments.length > 0) {
                      const paymentMethods = order.payments.map((p: any) => p.method?.code).filter(Boolean);
                      console.log('Order payment methods:', paymentMethods);
                      
                      const hasOfflinePayment = paymentMethods.some(
                          (code: string) => code === 'offline' || code === 'dummy-payment-handler'
                      );
                      
                      if (hasOfflinePayment) {
                          console.log('Hiding button: offline payment detected');
                          return { visible: false, disabled: false };
                      }
                  }
                  
                  // Show button only if has Razorpay Order ID and not offline
                  console.log('Showing button: Razorpay Order ID exists');
                  return {
                      visible: true,
                      disabled: false
                  };
              })
          );
      },
      onClick: (_event, context) => {
          const modalService = context.injector.get(ModalService);
          const orderId = context.route.snapshot.paramMap.get('id') || undefined;
          modalService.fromComponent(RazorpayStatusDialogComponent, {
              size: 'lg',
              closable: true,
              locals: { orderId },
          }).subscribe();
      },
  }),

  registerAlert({
      id: 'razorpay-stuck-orders',
      check: (context) => {
          return context.dataService
              .query(GET_RAZORPAY_ALERTS)
              .mapStream((data: any) => data.getRazorpayAlerts as RazorpayAlert[]);
      },
      recheck: () => interval(5 * 60 * 1000),
      isAlert: (data) => data && data.length > 0,
      label: (data) => {
          const count = data?.length || 0;
          return {
              text: count === 1
                  ? '1 Razorpay order needs attention'
                  : `${count} Razorpay orders need attention`,
              type: 'warning'
          };
      },
      action: (data, context) => {
          if (data && data.length > 0) {
              const router = context.injector.get(Router);
              router.navigate(['/orders', data[0].orderId]);
          }
      },
      requiredPermissions: [Permission.ReadOrder],
  }),
];
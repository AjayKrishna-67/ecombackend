import {
  registerDashboardWidget,
  setDashboardWidgetLayout,
} from '@vendure/admin-ui/core';
import { StockWidgetComponent } from './stock-widget';

export default [
  registerDashboardWidget('stock-levels', {
    title: 'Low stock',
    supportedWidths: [4, 6, 8, 12],
    loadComponent: () => Promise.resolve(StockWidgetComponent),
  }),
  // This layout now includes your new 'stock-levels' widget
  setDashboardWidgetLayout([
    { id: 'welcome', width: 12 },
    { id: 'orderSummary', width: 6 },
    { id: 'reviews', width: 6 },
    { id: 'stock-levels', width: 12 },
    { id: 'latestOrders', width: 12 },
  ]),
];
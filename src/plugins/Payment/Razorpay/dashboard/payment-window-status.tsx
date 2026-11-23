import { Badge, DashboardFormComponent } from '@vendure/dashboard';
import { Circle } from 'lucide-react';
import React from 'react';

export const PaymentWindowStatus: DashboardFormComponent = ({ value }) => {
    const isActive = value === true;
    return (
        <Badge variant={isActive ? 'success' : 'outline'} className="text-xs uppercase tracking-wide">
            <Circle size={6} fill="currentColor" className="mr-1" />
            {isActive ? 'Active' : 'Inactive'}
        </Badge>
    );
};

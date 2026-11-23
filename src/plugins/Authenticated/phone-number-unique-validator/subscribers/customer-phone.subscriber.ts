// customer-phone.subscriber.ts
import {
    EventSubscriber,
    EntitySubscriberInterface,
    UpdateEvent,
    DataSource,
} from 'typeorm';
import { Customer, UserInputError } from '@vendure/core';
import { Injectable } from '@nestjs/common';

@Injectable()
@EventSubscriber()
export class CustomerPhoneSubscriber implements EntitySubscriberInterface<Customer> {
    constructor(dataSource: DataSource) {
        dataSource.subscribers.push(this);
    }

    listenTo() {
        return Customer;
    }

    async beforeUpdate(event: UpdateEvent<Customer>): Promise<void> {
        // Get the new phone number from the update
        const newPhoneNumber = event.entity?.phoneNumber;

        if (!newPhoneNumber) {
            return;
        }

        // Get the customer ID being updated
        const customerId = event.entity?.id;
        if (!customerId) {
            return;
        }

        // Check if another customer already has this phone number
        const existingCustomer = await event.manager
            .getRepository(Customer)
            .createQueryBuilder('customer')
            .where('customer.phoneNumber = :phoneNumber', { phoneNumber: newPhoneNumber })
            .andWhere('customer.id != :id', { id: customerId })
            .andWhere('customer.deletedAt IS NULL')
            .getOne();

        if (existingCustomer) {
            throw new UserInputError('This phone number is already registered with another account.');
        }
    }
}

import { addActionBarItem, ModalService, Permission } from '@vendure/admin-ui/core';
import { ImportProductsDialogComponent } from './import-products-dialog.component';

export default [
    addActionBarItem({
        id: 'import-products',
        label: 'Import Products',
        locationId: 'product-list',
        icon: 'upload',
        requiresPermission: Permission.SuperAdmin,
        onClick: (_event, context) => {
            const modalService = context.injector.get(ModalService);
            modalService
                .fromComponent(ImportProductsDialogComponent, {
                    size: 'md',
                    closable: true,
                })
                .subscribe();
        },
    }),
];

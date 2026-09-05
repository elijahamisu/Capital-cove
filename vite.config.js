import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        register: resolve(__dirname, 'register.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        marketplace: resolve(__dirname, 'marketplace.html'),
       productDetails: resolve(__dirname, 'product-details.html'),
       buyBulk: resolve(__dirname, 'buy-bulk.html'),
        myProducts: resolve(__dirname, 'my-products.html'),
       productSales: resolve(__dirname, 'product-sales.html'),
        wallet: resolve(__dirname, 'wallet.html'),
        deposit: resolve(__dirname, 'deposit.html'),
        withdraw: resolve(__dirname, 'withdraw.html'),
        //transactions: resolve(__dirname, 'transactions.html'),
      //  referrals: resolve(__dirname, 'referrals.html'),
        //giftCode: resolve(__dirname, 'gift-code.html'),
        //notifications: resolve(__dirname, 'notifications.html'),
        //profile: resolve(__dirname, 'profile.html'),
       // support: resolve(__dirname, 'support.html'),
        //terms: resolve(__dirname, 'terms.html'),
        //privacy: resolve(__dirname, 'privacy.html'),
        // Admin Routes
        //adminLogin: resolve(__dirname, 'admin/login.html'),
        //adminDashboard: resolve(__dirname, 'admin/index.html'),
        //adminUsers: resolve(__dirname, 'admin/users.html'),
       // adminUserDetails: resolve(__dirname, 'admin/user-details.html'),
        //adminProducts: resolve(__dirname, 'admin/products.html'),
       // adminInventory: resolve(__dirname, 'admin/inventory.html'),
       // adminBulkPurchases: resolve(__dirname, 'admin/bulk-purchases.html'),
      //  adminSales: resolve(__dirname, 'admin/sales.html'),
        //adminSettlements: resolve(__dirname, 'admin/settlements.html'),
       // adminDeposits: resolve(__dirname, 'admin/deposits.html'),
       // adminWithdrawals: resolve(__dirname, 'admin/withdrawals.html'),
       // adminTransactions: resolve(__dirname, 'admin/transactions.html'),
        //adminReferrals: resolve(__dirname, 'admin/referrals.html'),
        //adminGiftCodes: resolve(__dirname, 'admin/gift-codes.html'),
        //adminNotifications: resolve(__dirname, 'admin/notifications.html'),
       // adminReports: resolve(__dirname, 'admin/reports.html'),
        //adminSettings: resolve(__dirname, 'admin/settings.html'),
       // adminLogs: resolve(__dirname, 'admin/admin-logs.html')
      }
    }
  }
});

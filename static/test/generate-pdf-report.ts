import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

// ── Test Results Data ──────────────────────────────────────────────
const reportDate = new Date().toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

interface TestResult {
    name: string;
    status: 'PASS' | 'FAIL';
    duration: string;
    note?: string;
}

interface TestSuite {
    name: string;
    tests: TestResult[];
}

const config = {
    endpoint: 'http://localhost:80/shop-api',
    adminEndpoint: 'http://localhost:80/admin-api',
    channel: 'ind-coimbatore',
    authPhone: '9488946262',
    productVariantId: '14',
    postalCode: '641001',
};

const suites: TestSuite[] = [
    {
        name: 'Cart Validation Plugin',
        tests: [
            { name: 'Active order has validationStatus field', status: 'PASS', duration: '173ms' },
            { name: 'Valid cart reports isValid=true', status: 'PASS', duration: '235ms' },
            { name: 'Order lines have isAvailable field', status: 'PASS', duration: '227ms' },
            { name: 'Valid cart allows checkout transition', status: 'PASS', duration: '442ms' },
            { name: 'Disabled product blocks checkout', status: 'PASS', duration: '100ms', note: 'Disabled product variant not accessible in shop API (ENTITY_NOT_FOUND) - expected behavior' },
            { name: 'Empty cart has valid validation status', status: 'PASS', duration: '194ms' },
            { name: 'isValid and hasUnavailableItems are inverses', status: 'PASS', duration: '153ms' },
            { name: 'totalUnavailableItems matches array length', status: 'PASS', duration: '212ms' },
            { name: 'Available line has null unavailableReason', status: 'PASS', duration: '285ms' },
            { name: 'Validation persists after adding second item', status: 'PASS', duration: '565ms' },
        ],
    },
    {
        name: 'Quantity Limit Plugin',
        tests: [
            { name: 'Active order has quantityLimitStatus field', status: 'PASS', duration: '228ms' },
            { name: 'No-limit product reports isValid=true', status: 'PASS', duration: '214ms' },
            { name: 'Order has stock availability fields', status: 'PASS', duration: '229ms' },
            { name: 'In-stock product reports isAvailable=true', status: 'PASS', duration: '230ms' },
            { name: 'Limited product exceeding max is blocked', status: 'PASS', duration: '143ms', note: 'OrderInterceptorError returned as expected' },
            { name: 'Out-of-stock product blocks checkout', status: 'PASS', duration: '77ms', note: 'InsufficientStockError returned as expected' },
            { name: 'Adjust quantity validates limits', status: 'PASS', duration: '212ms' },
            { name: 'Empty cart has valid quantity limit status', status: 'PASS', duration: '286ms' },
            { name: 'Violations array empty when status is valid', status: 'PASS', duration: '176ms' },
            { name: 'isValid and hasViolations are inverses', status: 'PASS', duration: '214ms' },
            { name: 'Adding same item twice accumulates quantity', status: 'PASS', duration: '314ms' },
            { name: 'Remove line then re-add works correctly', status: 'PASS', duration: '387ms' },
            { name: 'Adjust quantity to 1 preserves validity', status: 'PASS', duration: '283ms' },
            { name: 'Multiple sequential adds keep order valid', status: 'PASS', duration: '405ms' },
        ],
    },
    {
        name: 'Price Update Plugin',
        tests: [
            { name: 'Order lines have price fields', status: 'PASS', duration: '229ms' },
            { name: 'Line prices match current variant prices', status: 'PASS', duration: '258ms' },
            { name: 'Active order query returns pricing data', status: 'PASS', duration: '34ms' },
            { name: 'Multiple queries return consistent prices', status: 'PASS', duration: '269ms' },
            { name: 'linePriceWithTax equals unitPriceWithTax * quantity', status: 'PASS', duration: '220ms' },
            { name: 'subTotal matches sum of line prices', status: 'PASS', duration: '249ms' },
            { name: 'totalWithTax >= subTotalWithTax', status: 'PASS', duration: '232ms' },
            { name: 'Order code is non-empty string', status: 'PASS', duration: '202ms' },
        ],
    },
    {
        name: 'Channel Availability Plugin',
        tests: [
            { name: 'Query returns channel availability results', status: 'PASS', duration: '35ms' },
            { name: 'Channels have all required fields', status: 'PASS', duration: '33ms' },
            { name: 'Default channel is excluded', status: 'PASS', duration: '30ms' },
            { name: 'Filter by channel type works', status: 'PASS', duration: '51ms' },
            { name: 'Without postal code channels are unavailable', status: 'PASS', duration: '19ms' },
            { name: 'Unavailable brand has null token', status: 'PASS', duration: '33ms' },
            { name: 'Non-empty results for valid postal code', status: 'PASS', duration: '30ms' },
            { name: 'Available channel has non-null token', status: 'PASS', duration: '37ms' },
            { name: 'All channels have unique ids', status: 'PASS', duration: '35ms' },
            { name: 'Consistent results across repeated queries', status: 'PASS', duration: '69ms' },
            { name: 'CITY + BRAND filter counts sum to total', status: 'PASS', duration: '89ms' },
            { name: 'Available channel message is null', status: 'PASS', duration: '32ms' },
        ],
    },
    {
        name: 'Full Checkout Flow (All Plugins)',
        tests: [
            { name: 'Add -> Validate -> Checkout with all plugins', status: 'PASS', duration: '584ms' },
            { name: 'Multiple items validated by all plugins', status: 'PASS', duration: '250ms' },
            { name: 'Channel availability with active order context', status: 'PASS', duration: '32ms' },
            { name: 'Add -> Remove -> Add validates correctly', status: 'PASS', duration: '466ms' },
            { name: 'Adjust quantity then full validation', status: 'PASS', duration: '318ms' },
            { name: 'Round-trip state transition preserves validity', status: 'PASS', duration: '521ms' },
        ],
    },
];

// ── PDF Generation ─────────────────────────────────────────────────
const outputPath = path.join(__dirname, 'e2e-test-report.pdf');
const doc = new PDFDocument({ margin: 50, size: 'A4' });
const stream = fs.createWriteStream(outputPath);
doc.pipe(stream);

// Colors
const GREEN = '#16a34a';
const RED = '#dc2626';
const DARK = '#1e293b';
const GRAY = '#64748b';
const LIGHT_BG = '#f8fafc';
const BORDER = '#e2e8f0';
const ACCENT = '#3b82f6';

// ── Helper Functions ───────────────────────────────────────────────
function drawHorizontalLine(y: number, color = BORDER) {
    doc.strokeColor(color).lineWidth(0.5).moveTo(50, y).lineTo(545, y).stroke();
}

function checkPageSpace(needed: number) {
    if (doc.y + needed > 750) {
        doc.addPage();
    }
}

// ── Title Page ─────────────────────────────────────────────────────
doc.rect(0, 0, 595.28, 140).fill(DARK);

doc.fontSize(28).fillColor('#ffffff').text('E2E Test Report', 50, 45, { align: 'center' });
doc.fontSize(12).fillColor('#94a3b8').text('Active Order Plugins - Vendure v3.1.0', 50, 85, { align: 'center' });
doc.fontSize(10).fillColor('#94a3b8').text(reportDate, 50, 108, { align: 'center' });

// Summary box
const totalTests = suites.reduce((sum, s) => sum + s.tests.length, 0);
const passedTests = suites.reduce((sum, s) => sum + s.tests.filter(t => t.status === 'PASS').length, 0);
const failedTests = totalTests - passedTests;
const totalDuration = '13.10s';

doc.y = 165;

// Summary cards
const cardWidth = 115;
const cardHeight = 60;
const cardY = 165;
const cardSpacing = 10;
const startX = 50;

// Total card
doc.roundedRect(startX, cardY, cardWidth, cardHeight, 5).fillAndStroke(LIGHT_BG, BORDER);
doc.fontSize(24).fillColor(DARK).text(String(totalTests), startX, cardY + 10, { width: cardWidth, align: 'center' });
doc.fontSize(9).fillColor(GRAY).text('TOTAL TESTS', startX, cardY + 40, { width: cardWidth, align: 'center' });

// Passed card
doc.roundedRect(startX + cardWidth + cardSpacing, cardY, cardWidth, cardHeight, 5).fillAndStroke('#f0fdf4', GREEN);
doc.fontSize(24).fillColor(GREEN).text(String(passedTests), startX + cardWidth + cardSpacing, cardY + 10, { width: cardWidth, align: 'center' });
doc.fontSize(9).fillColor(GREEN).text('PASSED', startX + cardWidth + cardSpacing, cardY + 40, { width: cardWidth, align: 'center' });

// Failed card
const failColor = failedTests > 0 ? RED : '#6b7280';
const failBg = failedTests > 0 ? '#fef2f2' : LIGHT_BG;
doc.roundedRect(startX + 2 * (cardWidth + cardSpacing), cardY, cardWidth, cardHeight, 5).fillAndStroke(failBg, failedTests > 0 ? RED : BORDER);
doc.fontSize(24).fillColor(failColor).text(String(failedTests), startX + 2 * (cardWidth + cardSpacing), cardY + 10, { width: cardWidth, align: 'center' });
doc.fontSize(9).fillColor(failColor).text('FAILED', startX + 2 * (cardWidth + cardSpacing), cardY + 40, { width: cardWidth, align: 'center' });

// Duration card
doc.roundedRect(startX + 3 * (cardWidth + cardSpacing), cardY, cardWidth, cardHeight, 5).fillAndStroke(LIGHT_BG, BORDER);
doc.fontSize(20).fillColor(DARK).text(totalDuration, startX + 3 * (cardWidth + cardSpacing), cardY + 12, { width: cardWidth, align: 'center' });
doc.fontSize(9).fillColor(GRAY).text('DURATION', startX + 3 * (cardWidth + cardSpacing), cardY + 40, { width: cardWidth, align: 'center' });

// Pass rate
doc.y = cardY + cardHeight + 25;
const passRate = ((passedTests / totalTests) * 100).toFixed(1);
doc.fontSize(11).fillColor(DARK).text(`Pass Rate: ${passRate}%`, 50, doc.y);

// Progress bar
const barY = doc.y + 18;
const barWidth = 495;
const barHeight = 10;
doc.roundedRect(50, barY, barWidth, barHeight, 5).fill(BORDER);
const passWidth = (passedTests / totalTests) * barWidth;
doc.roundedRect(50, barY, passWidth, barHeight, 5).fill(GREEN);

// ── Configuration Section ──────────────────────────────────────────
doc.y = barY + 30;
drawHorizontalLine(doc.y);
doc.y += 12;

doc.fontSize(14).fillColor(DARK).text('Test Configuration', 50, doc.y);
doc.y += 22;

const configItems = [
    ['Endpoint', config.endpoint],
    ['Admin API', config.adminEndpoint],
    ['Channel Token', config.channel],
    ['Auth Phone', config.authPhone],
    ['Product Variant ID', config.productVariantId],
    ['Postal Code', config.postalCode],
];

for (const [key, value] of configItems) {
    doc.fontSize(9).fillColor(GRAY).text(`${key}:`, 60, doc.y, { continued: true });
    doc.fillColor(DARK).text(`  ${value}`);
    doc.y += 2;
}

// ── Admin Setup Summary ────────────────────────────────────────────
doc.y += 10;
drawHorizontalLine(doc.y);
doc.y += 12;

doc.fontSize(14).fillColor(DARK).text('Admin Setup Actions', 50, doc.y);
doc.y += 22;

const setupActions = [
    'Ensured variant 14 has trackInventory=FALSE',
    'Discovered disabled product: Guava (id=5), variant 16',
    'Set maxOrderQuantity=3 on variant 15 (Pomegranate 1 KG)',
    'Set trackInventory=TRUE and stock=0 on variant 20 (Apple 1/2 KG)',
];

for (const action of setupActions) {
    doc.fontSize(9).fillColor(GREEN).text('  >', 55, doc.y, { continued: true });
    doc.fillColor(DARK).text(`  ${action}`);
    doc.y += 2;
}

// ── Test Suite Details ─────────────────────────────────────────────
for (const suite of suites) {
    checkPageSpace(80 + suite.tests.length * 28);

    doc.y += 15;
    drawHorizontalLine(doc.y);
    doc.y += 15;

    // Suite header
    const suitePassed = suite.tests.filter(t => t.status === 'PASS').length;
    const suiteFailed = suite.tests.length - suitePassed;

    doc.fontSize(14).fillColor(DARK).text(suite.name, 50, doc.y);
    doc.y += 4;
    doc.fontSize(9).fillColor(GRAY).text(
        `${suite.tests.length} tests | ${suitePassed} passed${suiteFailed > 0 ? ` | ${suiteFailed} failed` : ''}`
    );
    doc.y += 10;

    // Test rows
    for (let i = 0; i < suite.tests.length; i++) {
        const test = suite.tests[i];
        checkPageSpace(35);

        const rowY = doc.y;
        const rowBg = i % 2 === 0 ? '#ffffff' : LIGHT_BG;
        doc.rect(50, rowY, 495, 22).fill(rowBg);

        // Status indicator
        const statusColor = test.status === 'PASS' ? GREEN : RED;
        doc.circle(65, rowY + 11, 4).fill(statusColor);

        // Test name
        doc.fontSize(9).fillColor(DARK).text(test.name, 78, rowY + 6, { width: 370 });

        // Duration
        doc.fontSize(8).fillColor(GRAY).text(test.duration, 460, rowY + 7, { width: 80, align: 'right' });

        doc.y = rowY + 22;

        // Note (if any)
        if (test.note) {
            checkPageSpace(18);
            doc.fontSize(7).fillColor(ACCENT).text(`    Note: ${test.note}`, 78, doc.y + 1, { width: 440 });
            doc.y += 14;
        }
    }
}

// ── Footer ─────────────────────────────────────────────────────────
checkPageSpace(60);
doc.y += 20;
drawHorizontalLine(doc.y);
doc.y += 15;

doc.fontSize(9).fillColor(GRAY).text('Test File: static/test/real-e2e-test.ts', 50, doc.y);
doc.y += 14;
doc.fontSize(9).fillColor(GRAY).text('Framework: Vendure 3.1.0 | Platform: Kaaikani E-Commerce', 50, doc.y);
doc.y += 14;
doc.fontSize(8).fillColor(GRAY).text('Generated automatically by E2E Test Report Generator', 50, doc.y, { align: 'center', width: 495 });

doc.end();

stream.on('finish', () => {
    console.log(`PDF report generated: ${outputPath}`);
});

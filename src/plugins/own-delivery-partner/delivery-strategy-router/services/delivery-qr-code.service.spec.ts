import { describe, expect, it, vi } from 'vitest';

import { extractUpiUri, generateQrDataUrl } from './delivery-qr-code.service';
import QRCode from 'qrcode';
import sharp from 'sharp';
import jsQR from 'jsqr';

// Silence the Vendure Logger during tests
vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

/**
 * Create a real QR image containing the given content, as if Razorpay
 * generated it. Returns a PNG buffer.
 */
async function createTestQrImage(content: string): Promise<Buffer> {
    const dataUrl = await QRCode.toDataURL(content, { type: 'image/png', width: 300 });
    const base64 = dataUrl.split(',')[1];
    return Buffer.from(base64, 'base64');
}

describe('extractUpiUri', () => {
    it('throws on missing image_url and image_content', async () => {
        await expect(extractUpiUri({})).rejects.toThrow(/No image_url or image_content/);
    });

    it('uses image_content directly when available (fast path)', async () => {
        const upiUri = 'upi://pay?pa=kaaikani@axis&pn=KAAIKANI&am=219.00&tr=RZPqr_test123&cu=INR';
        const result = await extractUpiUri({ image_content: upiUri });
        expect(result).toBe(upiUri);
    });

    it('extracts UPI URI from a Razorpay QR image (slow path)', async () => {
        const upiUri = 'upi://pay?pa=kaaikani@axis&pn=KAAIKANI&am=219.00&tr=RZPqr_test123&cu=INR';
        const fakeRazorpayImage = await createTestQrImage(upiUri);

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            arrayBuffer: async () => fakeRazorpayImage.buffer.slice(
                fakeRazorpayImage.byteOffset,
                fakeRazorpayImage.byteOffset + fakeRazorpayImage.byteLength,
            ),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await extractUpiUri({ image_url: 'http://rzp.io/i/test123' });
        expect(result).toBe(upiUri);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toBe('https://rzp.io/i/test123');

        vi.unstubAllGlobals();
    });

    it('throws when fetch fails', async () => {
        // mockResolvedValue (not Once) — extractUpiUri retries the fetch
        // up to 3 times, so every attempt must see the same 503.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
        }));
        await expect(extractUpiUri({ image_url: 'http://rzp.io/i/fail' }))
            .rejects.toThrow(/HTTP 503/);
        vi.unstubAllGlobals();
    });

    it('throws when image contains no decodable QR', async () => {
        const blankImage = await sharp({
            create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
        }).png().toBuffer();

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: true,
            arrayBuffer: async () => blankImage.buffer.slice(
                blankImage.byteOffset,
                blankImage.byteOffset + blankImage.byteLength,
            ),
        }));
        await expect(extractUpiUri({ image_url: 'http://rzp.io/i/blank' }))
            .rejects.toThrow(/Could not decode/);
        vi.unstubAllGlobals();
    });

    it('generates a small QR image (<5KB)', async () => {
        const upiUri = 'upi://pay?pa=test@axis&am=100.00&cu=INR';
        const result = await generateQrDataUrl(upiUri);
        const base64 = result.split(',')[1];
        const sizeKB = Buffer.from(base64, 'base64').byteLength / 1024;
        expect(sizeKB).toBeLessThan(5);

        vi.unstubAllGlobals();
    });
});

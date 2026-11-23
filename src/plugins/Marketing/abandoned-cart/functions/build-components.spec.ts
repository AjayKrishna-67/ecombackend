import { describe, expect, it } from 'vitest';
import { buildWhatsappComponents, toFullSizeImageUrl } from './build-components';

describe('toFullSizeImageUrl', () => {
    it('strips preset=thumb so WhatsApp gets the full-size image', () => {
        expect(toFullSizeImageUrl('https://k.co/assets/preview/67/x__preview.png?preset=thumb'))
            .toBe('https://k.co/assets/preview/67/x__preview.png');
    });
    it('keeps other query params, drops only preset', () => {
        expect(toFullSizeImageUrl('https://k.co/x.png?preset=thumb&v=2')).toBe('https://k.co/x.png?v=2');
        expect(toFullSizeImageUrl('https://k.co/x.png?v=2&preset=large')).toBe('https://k.co/x.png?v=2');
    });
    it('leaves preset-free urls untouched', () => {
        expect(toFullSizeImageUrl('http://img/x.jpg')).toBe('http://img/x.jpg');
    });
});

describe('buildWhatsappComponents', () => {
    const vars = { body_1: { type: 'text' as const, value: 'hi' } };
    it('sends full-size header image (strips preset)', () => {
        expect(buildWhatsappComponents({ vars, headerImageUrl: 'http://img/x.jpg?preset=thumb' }).header_1)
            .toEqual({ type: 'image', value: 'http://img/x.jpg' });
    });
    it('body only when no header/button', () => {
        expect(buildWhatsappComponents({ vars })).toEqual({ body_1: { type: 'text', value: 'hi' } });
    });
    it('includes header_1 image when headerImageUrl set', () => {
        expect(buildWhatsappComponents({ vars, headerImageUrl: 'http://img/x.jpg' })).toEqual({
            header_1: { type: 'image', value: 'http://img/x.jpg' },
            body_1: { type: 'text', value: 'hi' },
        });
    });
    it('includes button_1 url when buttonUrlValue set', () => {
        expect(buildWhatsappComponents({ vars, buttonUrlValue: 'abc' })).toEqual({
            body_1: { type: 'text', value: 'hi' },
            button_1: { subtype: 'url', type: 'text', value: 'abc' },
        });
    });
    it('omits empty-string header/button', () => {
        expect(buildWhatsappComponents({ vars, headerImageUrl: '', buttonUrlValue: '' })).toEqual({ body_1: { type: 'text', value: 'hi' } });
    });
});

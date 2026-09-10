import { expect } from 'chai';

import { createSpsLevelPatcher, requiredLevel } from './h264';

/** Real SPS of a Wall Light Cam S100 at video_streaming_quality 2 - 1600x1200, declared level 4.2. */
const SPS_1600x1200 = Buffer.from(
    '2764002aad00ce8064025e9a808080f8000003000800000300f18000038f700005572efffe0500',
    'hex',
);

/** Real SPS of the same camera at video_streaming_quality 1 - 800x600, declared level 4.2. */
const SPS_800x600 = Buffer.from('2764002aad00ce80c8137e59a808080f80000003008000000f188000514c0003cf96fffe0500', 'hex');

const startCode = Buffer.from([0, 0, 0, 1]);
const pps = Buffer.from('68ee3cb0', 'hex');

const collect = async (chunks: Buffer[], fps = 15): Promise<Buffer> => {
    const patcher = createSpsLevelPatcher(fps);
    const out: Buffer[] = [];
    patcher.on('data', (chunk: Buffer) => out.push(chunk));
    for (const chunk of chunks) {
        patcher.write(chunk);
    }
    patcher.end();
    await new Promise(resolve => patcher.on('end', resolve));
    return Buffer.concat(out);
};

describe('h264 => requiredLevel', () => {
    it('should ask for level 4.0 for the 1600x1200 stream the camera declares as 4.2', () => {
        expect(requiredLevel(SPS_1600x1200, 15)).to.equal(40);
    });

    it('should ask for level 3.1 for the 800x600 stream the camera declares as 4.2', () => {
        expect(requiredLevel(SPS_800x600, 15)).to.equal(31);
    });

    it('should not lower the level when the camera reports a high frame rate', () => {
        expect(requiredLevel(SPS_1600x1200, 60)).to.equal(42);
    });

    it('should ignore a reported frame rate below the assumed one', () => {
        expect(requiredLevel(SPS_1600x1200, 1)).to.equal(requiredLevel(SPS_1600x1200, 30));
    });

    it('should return undefined for something that is not an SPS', () => {
        expect(requiredLevel(Buffer.from('deadbeef', 'hex'), 15)).to.equal(undefined);
    });

    it('should return undefined for a truncated SPS', () => {
        expect(requiredLevel(SPS_1600x1200.subarray(0, 4), 15)).to.equal(undefined);
    });
});

describe('h264 => createSpsLevelPatcher', () => {
    it('should replace the declared level of an SPS', async () => {
        const out = await collect([Buffer.concat([startCode, SPS_1600x1200, startCode, pps])]);

        expect(out[startCode.length + 3]).to.equal(40);
        expect(out.length).to.equal(startCode.length * 2 + SPS_1600x1200.length + pps.length);
    });

    it('should leave everything but the level byte untouched', async () => {
        const input = Buffer.concat([startCode, SPS_800x600, startCode, pps]);
        const out = await collect([Buffer.from(input)]);
        const levelAt = startCode.length + 3;

        expect(out[levelAt]).to.equal(31);
        out[levelAt] = input[levelAt];
        expect(out.equals(input)).to.equal(true);
    });

    it('should patch an SPS that is split across chunks', async () => {
        const input = Buffer.concat([startCode, SPS_1600x1200, startCode, pps]);
        const chunks: Buffer[] = [];
        for (let i = 0; i < input.length; i += 3) {
            chunks.push(Buffer.from(input.subarray(i, i + 3)));
        }
        const out = await collect(chunks);

        expect(out[startCode.length + 3]).to.equal(40);
        expect(out.length).to.equal(input.length);
    });

    it('should patch every repeated SPS, because go2rtc builds its init segment from any of them', async () => {
        const gop = Buffer.concat([
            startCode,
            SPS_1600x1200,
            startCode,
            pps,
            startCode,
            Buffer.from('65aabbcc', 'hex'),
        ]);
        const out = await collect([gop, Buffer.from(gop), Buffer.from(gop)]);
        const levels: number[] = [];
        for (let i = 0; i + 6 < out.length; i++) {
            if (out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 1 && (out[i + 3] & 0x1f) === 7) {
                levels.push(out[i + 6]);
            }
        }

        expect(levels).to.deep.equal([40, 40, 40]);
        expect(out.length).to.equal(gop.length * 3);
    });

    it('should pass a stream without a readable SPS through untouched', async () => {
        const input = Buffer.concat([startCode, Buffer.from('67ffffff', 'hex'), startCode, pps]);
        const out = await collect([Buffer.from(input)]);

        expect(out.equals(input)).to.equal(true);
    });

    it('should pass a stream without any SPS through untouched', async () => {
        const input = Buffer.concat([startCode, Buffer.from('65aabbccdd', 'hex')]);
        const out = await collect([Buffer.from(input)]);

        expect(out.equals(input)).to.equal(true);
    });
});

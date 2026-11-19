import { expect } from 'chai';

import { createKeyframeGate, createSpsLevelPatcher, requiredLevel, spsGeometry } from './h264';

/** Real SPS of a Wall Light Cam S100 at video_streaming_quality 2 - 1600x1200, declared level 4.2. */
const SPS_1600x1200 = Buffer.from(
    '2764002aad00ce8064025e9a808080f8000003000800000300f18000038f700005572efffe0500',
    'hex',
);

/** Real SPS of the same camera at video_streaming_quality 1 - 800x600, declared level 4.2. */
const SPS_800x600 = Buffer.from('2764002aad00ce80c8137e59a808080f80000003008000000f188000514c0003cf96fffe0500', 'hex');

/**
 * Real SPS the same camera sent at the start of the first livestream of a morning, although it
 * streams at 1600x1200 - 2048x1536, declared level 5.0. 1.4 s later it switched to 1600x1200.
 */
const SPS_2048x1536 = Buffer.from(
    '27640032ad00ce802000c1a6a020203e0000030002000003003c64000145700007a0a2fffe05',
    'hex',
);

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

describe('h264 => spsGeometry', () => {
    it('should read the size of the SPS the camera sends at quality 2', () => {
        expect(spsGeometry(SPS_1600x1200)).to.equal('1600x1200');
    });

    it('should read the size of the SPS the camera sends at quality 1 before cropping', () => {
        expect(spsGeometry(SPS_800x600)).to.equal('800x608');
    });

    it('should read the size of the SPS a cold livestream starts with', () => {
        expect(spsGeometry(SPS_2048x1536)).to.equal('2048x1536');
    });

    it('should return undefined for something that is not an SPS', () => {
        expect(spsGeometry(Buffer.from('67ffffffffffffff', 'hex'))).to.equal(undefined);
        expect(spsGeometry(Buffer.alloc(0))).to.equal(undefined);
    });

    it('should return undefined for an SPS cut off before its size', () => {
        expect(spsGeometry(SPS_1600x1200.subarray(0, 8))).to.equal(undefined);
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

    it('should leave an SPS alone that declares a lower level than the stream needs', async () => {
        // Same 1600x1200 stream, but declared as level 3.0 - it needs 4.0, and claiming more than
        // the camera did helps no decoder.
        const understated = Buffer.from(SPS_1600x1200);
        understated[3] = 30;
        const input = Buffer.concat([startCode, understated, startCode, pps]);
        const out = await collect([Buffer.from(input)]);

        expect(out.equals(input)).to.equal(true);
    });

    it('should keep patching after an SPS it could not read, instead of trusting the first one', async () => {
        // The first bytes after a freshly built P2P session are not always a clean SPS. A cached
        // level would be stamped into every following SPS of the livestream.
        const unreadable = Buffer.from('67ffffffffffffff', 'hex');
        const input = Buffer.concat([
            startCode,
            unreadable,
            startCode,
            SPS_1600x1200,
            startCode,
            pps,
            startCode,
            SPS_1600x1200,
            startCode,
            pps,
        ]);
        const out = await collect([Buffer.from(input)]);
        const levels: number[] = [];
        for (let i = 0; i + 6 < out.length; i++) {
            if (out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 1 && (out[i + 3] & 0x1f) === 7) {
                levels.push(out[i + 6]);
            }
        }

        expect(levels).to.deep.equal([0xff, 40, 40]);
        expect(out.length).to.equal(input.length);
    });

    it('should pass a stream without any SPS through untouched', async () => {
        const input = Buffer.concat([startCode, Buffer.from('65aabbccdd', 'hex')]);
        const out = await collect([Buffer.from(input)]);

        expect(out.equals(input)).to.equal(true);
    });
});

describe('h264 => createKeyframeGate', () => {
    const sps = Buffer.concat([startCode, SPS_1600x1200, startCode, pps]);
    /** First slice of an IDR picture - first_mb_in_slice 0 is the single bit 1. */
    const idr = (tag: number): Buffer => Buffer.concat([startCode, Buffer.from([0x65, 0x88, tag, tag])]);
    /** Further slice of the same IDR picture - first_mb_in_slice 1. */
    const idrSlice = (tag: number): Buffer => Buffer.concat([startCode, Buffer.from([0x65, 0x40, tag, tag])]);
    const p = (tag: number): Buffer => Buffer.concat([startCode, Buffer.from([0x41, 0x9a, tag, tag])]);
    const gop = (tag: number): Buffer => Buffer.concat([sps, idr(tag), p(tag), p(tag)]);

    const gate = async (
        chunks: Buffer[],
        expected: string | null = '1600x1200',
    ): Promise<{ out: Buffer; dropped: number[]; opened: Array<[string | undefined, number]> }> => {
        const opened: Array<[string | undefined, number]> = [];
        const filter = createKeyframeGate(expected ?? undefined, (geometry, bytes) => opened.push([geometry, bytes]));
        const out: Buffer[] = [];
        filter.on('data', (chunk: Buffer) => out.push(chunk));
        for (const chunk of chunks) {
            filter.write(chunk);
        }
        filter.end();
        await new Promise(resolve => filter.on('end', resolve));
        const dropped = opened.filter(([, bytes]) => bytes > 0).map(([, bytes]) => bytes);
        return { out: Buffer.concat(out), dropped, opened };
    };
    const bytewise = (input: Buffer): Buffer[] => [...input].map(byte => Buffer.from([byte]));

    describe('warm start', () => {
        it('should hand on a stream that starts with its SPS untouched', async () => {
            const input = Buffer.concat([gop(1), gop(2)]);
            const { out, dropped } = await gate([input]);

            expect(out.equals(input)).to.equal(true);
            expect(dropped).to.deep.equal([]);
        });

        it('should report the resolution of a warm start once, with nothing dropped', async () => {
            const { opened } = await gate([gop(1), gop(2)]);

            expect(opened).to.deep.equal([['1600x1200', 0]]);
        });

        it('should hand on a stream that starts with its SPS untouched when it arrives byte by byte', async () => {
            const input = Buffer.concat([gop(1), gop(2)]);
            const { out, dropped } = await gate(bytewise(input));

            expect(out.equals(input)).to.equal(true);
            expect(dropped).to.deep.equal([]);
        });

        it('should keep bytes without a start code in front of the first SPS', async () => {
            const input = Buffer.concat([Buffer.from('ffff', 'hex'), gop(1)]);
            const { out } = await gate([input]);

            expect(out.equals(input)).to.equal(true);
        });

        it('should hand on a three-byte start code in front of the first SPS', async () => {
            const input = Buffer.concat([Buffer.from([0, 0, 1]), SPS_1600x1200, idr(1)]);
            const { out } = await gate([input]);

            expect(out.equals(input)).to.equal(true);
        });
    });

    describe('cold start', () => {
        it('should drop everything up to the parameter sets of the second keyframe', async () => {
            const { out, dropped } = await gate([Buffer.concat([p(0), gop(1), gop(2), gop(3)])]);

            expect(out.equals(Buffer.concat([gop(2), gop(3)]))).to.equal(true);
            expect(dropped).to.deep.equal([p(0).length + gop(1).length]);
        });

        it('should find the second keyframe when the stream arrives byte by byte', async () => {
            const input = Buffer.concat([p(0), gop(1), gop(2), gop(3)]);
            const { out, dropped } = await gate(bytewise(input));

            expect(out.equals(Buffer.concat([gop(2), gop(3)]))).to.equal(true);
            expect(dropped).to.deep.equal([p(0).length + gop(1).length]);
        });

        it('should treat a stream that starts with a keyframe without SPS as cold', async () => {
            const { out } = await gate([Buffer.concat([idr(1), p(1), idr(2), p(2)])]);

            expect(out.equals(Buffer.concat([idr(2), p(2)]))).to.equal(true);
        });

        it('should count a keyframe made of several slices only once', async () => {
            const sliced = (tag: number): Buffer => Buffer.concat([sps, idr(tag), idrSlice(tag), p(tag)]);
            const { out } = await gate([Buffer.concat([p(0), sliced(1), sliced(2)])]);

            expect(out.equals(sliced(2))).to.equal(true);
        });

        it('should not take an SPS that came before the last slice as the start of the keyframe', async () => {
            const { out } = await gate([Buffer.concat([p(0), gop(1), sps, p(1), idr(2), p(2)])]);

            expect(out.equals(Buffer.concat([idr(2), p(2)]))).to.equal(true);
        });

        it('should treat a clean start in another resolution as cold and report the one it opened at', async () => {
            // Seen on the live host: the first livestream of the morning began with a clean
            // keyframe at 2048x1536 and switched to the 1600x1200 it streams at 1.4 s later.
            // go2rtc builds no new init segment for that, and the tablet froze.
            const big = Buffer.concat([startCode, SPS_2048x1536, startCode, pps, idr(0), p(0)]);
            const { out, dropped, opened } = await gate([Buffer.concat([big, gop(1), gop(2)])]);

            expect(out.equals(Buffer.concat([gop(1), gop(2)]))).to.equal(true);
            expect(dropped).to.deep.equal([big.length]);
            expect(opened).to.deep.equal([['1600x1200', big.length]]);
        });

        it('should treat a clean start as cold while no resolution is known yet', async () => {
            const { out, opened } = await gate([Buffer.concat([gop(1), gop(2)])], null);

            expect(out.equals(gop(2))).to.equal(true);
            expect(opened).to.deep.equal([['1600x1200', gop(1).length]]);
        });

        it('should take the resolution of the second keyframe when it differs from the known one', async () => {
            // The quality was changed: one livestream pays for it, the next one starts at once.
            const { out, opened } = await gate([Buffer.concat([gop(1), gop(2)])], '2048x1536');

            expect(out.equals(gop(2))).to.equal(true);
            expect(opened).to.deep.equal([['1600x1200', gop(1).length]]);
        });

        it('should report no resolution when the second keyframe comes without an SPS', async () => {
            const { opened } = await gate([Buffer.concat([idr(1), p(1), idr(2), p(2)])]);

            expect(opened).to.deep.equal([[undefined, idr(1).length + p(1).length]]);
        });

        it('should treat a stream that starts with an unreadable SPS as cold', async () => {
            const unreadable = Buffer.concat([startCode, Buffer.from('67ffffffffffffff', 'hex'), startCode, pps]);
            const { out, dropped } = await gate([Buffer.concat([unreadable, p(0), gop(1), gop(2)])]);

            expect(out.equals(gop(2))).to.equal(true);
            expect(dropped).to.deep.equal([unreadable.length + p(0).length + gop(1).length]);
        });

        it('should count a keyframe behind an unreadable SPS as the first one', async () => {
            const unreadable = Buffer.concat([startCode, Buffer.from('67ffffffffffffff', 'hex'), startCode, pps]);
            const { out } = await gate([Buffer.concat([unreadable, idr(1), p(1), gop(2), gop(3)])]);

            expect(out.equals(Buffer.concat([gop(2), gop(3)]))).to.equal(true);
        });

        it('should treat a readable SPS that is followed by a picture that is no keyframe as cold', async () => {
            const { out } = await gate([Buffer.concat([sps, p(0), gop(1), gop(2)])]);

            expect(out.equals(gop(2))).to.equal(true);
        });

        it('should treat an SPS followed by a further slice of a keyframe as cold', async () => {
            const { out } = await gate([Buffer.concat([sps, idrSlice(0), p(0), gop(1), gop(2)])]);

            expect(out.equals(gop(2))).to.equal(true);
        });

        it('should hand on nothing from a stream that ends before its second keyframe', async () => {
            const { out, dropped } = await gate([p(0), gop(1), p(1)]);

            expect(out.length).to.equal(0);
            expect(dropped).to.deep.equal([]);
        });

        it('should pass everything after the second keyframe through untouched, junk included', async () => {
            const junk = Buffer.from('000001ff0000', 'hex');
            const { out } = await gate([p(0), gop(1), gop(2), junk, gop(3)]);

            expect(out.equals(Buffer.concat([gop(2), junk, gop(3)]))).to.equal(true);
        });
    });

    describe('invalid input', () => {
        it('should hand on nothing from empty chunks and data without any start code', async () => {
            const { out, dropped } = await gate([Buffer.alloc(0), Buffer.from('ffffffffffff', 'hex')]);

            expect(out.length).to.equal(0);
            expect(dropped).to.deep.equal([]);
        });

        it('should treat more than 64 KiB without a start code as a cold start and stop buffering it', async () => {
            const junk = Buffer.alloc(64 * 1024 + 1, 0xff);
            const { out, dropped } = await gate([junk, gop(1), gop(2)]);

            expect(out.equals(gop(2))).to.equal(true);
            expect(dropped).to.deep.equal([junk.length + gop(1).length]);
        });

        it('should treat more than 64 KiB after the SPS without any picture as a cold start', async () => {
            const junk = Buffer.alloc(64 * 1024, 0xff);
            const { out } = await gate([Buffer.concat([sps, junk]), gop(1), gop(2)]);

            expect(out.equals(gop(2))).to.equal(true);
        });

        it('should hand on a stream whose SPS is cut off at the end of a chunk once the rest arrives', async () => {
            const input = Buffer.concat([gop(1), gop(2)]);
            const cut = startCode.length + 6;
            const { out, dropped } = await gate([input.subarray(0, cut), input.subarray(cut)]);

            expect(out.equals(input)).to.equal(true);
            expect(dropped).to.deep.equal([]);
        });

        it('should keep exactly 64 KiB without a start code as the lead-in of a warm start', async () => {
            const junk = Buffer.alloc(64 * 1024, 0xff);
            const { out } = await gate([junk, gop(1)]);

            expect(out.equals(Buffer.concat([junk, gop(1)]))).to.equal(true);
        });
    });
});

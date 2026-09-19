import { expect } from 'chai';

import { withoutCveFlag } from '../cleanupCveFix.js';

const CVE_FLAG = '--security-revert=CVE-2023-46809';

describe('cleanupCveFix => withoutCveFlag', () => {
    it('should remove the flag set by adapter 2.x', () => {
        expect(withoutCveFlag([CVE_FLAG])).to.deep.equal([]);
    });

    it('should keep other node process parameters', () => {
        expect(withoutCveFlag(['--max-old-space-size=512', CVE_FLAG, '--trace-warnings'])).to.deep.equal([
            '--max-old-space-size=512',
            '--trace-warnings',
        ]);
    });

    it('should remove every occurrence of the flag', () => {
        expect(withoutCveFlag([CVE_FLAG, CVE_FLAG])).to.deep.equal([]);
    });

    it('should report nothing to do when the flag is absent', () => {
        expect(withoutCveFlag([])).to.equal(null);
        expect(withoutCveFlag(['--max-old-space-size=512'])).to.equal(null);
        expect(withoutCveFlag([`${CVE_FLAG}x`, 'CVE-2023-46809'])).to.equal(null);
    });

    it('should report nothing to do for a missing or malformed value', () => {
        expect(withoutCveFlag(undefined)).to.equal(null);
        expect(withoutCveFlag(null)).to.equal(null);
        expect(withoutCveFlag(CVE_FLAG)).to.equal(null);
        expect(withoutCveFlag({ 0: CVE_FLAG })).to.equal(null);
    });
});

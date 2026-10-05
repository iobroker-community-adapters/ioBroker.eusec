import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('io-package.json', () => {
    // js-controller replaces array attributes of an instance's common with the ones from
    // io-package.json on every upgrade. That is what removes --security-revert=CVE-2023-46809,
    // which adapter 2.x and older set and which keeps node 22 and newer from starting the instance.
    it('should clear the node process parameters of every instance on upgrade', () => {
        const ioPackage = JSON.parse(readFileSync(join(__dirname, '..', 'io-package.json'), 'utf-8'));
        expect(ioPackage.common.nodeProcessParams).to.deep.equal([]);
    });
});

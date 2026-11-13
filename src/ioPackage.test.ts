import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('io-package.json', () => {
    const ioPackage = JSON.parse(readFileSync(join(__dirname, '..', 'io-package.json'), 'utf-8'));

    // The host sends SIGKILL after stopTimeout, 1000 ms when it is missing. The adapter core alone
    // waits a fixed 500 ms after the unload and then closes its database clients, so a busy states
    // database (host shutdown, a stop right after the start) pushed the exit past 1000 ms.
    it('should give the instance more than the adapter core needs to shut down', () => {
        expect(ioPackage.common.stopTimeout).to.be.a('number').and.to.be.at.least(3000);
    });

    // js-controller replaces array attributes of an instance's common with the ones from
    // io-package.json on every upgrade. That is what removes --security-revert=CVE-2023-46809,
    // which adapter 2.x and older set and which keeps node 22 and newer from starting the instance.
    it('should clear the node process parameters of every instance on upgrade', () => {
        expect(ioPackage.common.nodeProcessParams).to.deep.equal([]);
    });
});

import { expect } from "chai";
import { deployments, ethers, waffle } from 'hardhat';
import "@nomiclabs/hardhat-ethers";
import { AddressZero } from "@ethersproject/constants";
import { getMockERC20, getSafeTemplate, getSafeWithOwners } from '../utils/setup';
import { safeSignTypedData, executeTx, safeSignMessage, calculateSafeTransactionHash, safeApproveHash, executeTxWithSigners, buildSafeTransaction, logGas, calculateSafeDomainSeparator, preimageSafeTransactionHash, buildSignatureBytes } from "../../src/utils/execution";
import { chainId } from "../utils/encoding";
import { Contract } from 'ethers';
import { parseEther } from 'ethers/lib/utils';

describe("GnosisSafe", async () => {

    const [user1, user2, user3, user4] = waffle.provider.getWallets()

    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const token = await getMockERC20();
        await token.transfer(user2.address, ethers.utils.parseEther('10'));
        await token.transfer(user3.address, ethers.utils.parseEther('10'));
        return {
            safe: await getSafeWithOwners([user1.address, user2.address, user3.address], token.address),
            token
        }
    })
    describe("domainSeparator", async () => {
        it('should be correct according to EIP-712', async () => {
            const { safe } = await setupTests()
            const domainSeparator = calculateSafeDomainSeparator(safe, await chainId())
            await expect(
                await safe.domainSeparator()
            ).to.be.eq(domainSeparator)
        })
    })

    describe("getTransactionHash", async () => {
        it('should correctly calculate EIP-712 hash', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const typedDataHash = calculateSafeTransactionHash(safe, tx, await chainId())
            await expect(
                await safe.getTransactionHash(
                    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce
                )
            ).to.be.eq(typedDataHash)
        })
    })

    describe("getChainId", async () => {
        it('should return correct id', async () => {
            const { safe } = await setupTests()
            expect(
                await safe.getChainId()
            ).to.be.eq(await chainId())
        })
    })

    describe("approveHash", async () => {
        it('approving should only be allowed for owners', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signerSafe = safe.connect(user4)
            await expect(
                signerSafe.approveHash(txHash)
            ).to.be.revertedWith("GS030")
        })

        it('approving should emit event', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            await expect(
                safe.approveHash(txHash)
            ).emit(safe, "ApproveHash").withArgs(txHash, user1.address)
        })
    })

    describe("execTransaction", async () => {

        it('should fail if sigantures data is not present', async () => {
            const { safe } = await setupTests()

            const signatures = "0x" + "000000000000000000000000" + user1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000041" + "00" // r, s, v

            await expect(
                safe.execTransaction(safe.address, 0, "0x", 0, 0, 0, 0, AddressZero, AddressZero, signatures)
            ).to.be.revertedWith("GS022")
        })

        it('should fail if sigantures data is too short', async () => {
            const { safe } = await setupTests()

            const signatures = "0x" + "000000000000000000000000" + user1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000041" + "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000020" // length

            await expect(
                safe.execTransaction(safe.address, 0, "0x", 0, 0, 0, 0, AddressZero, AddressZero, signatures)
            ).to.be.revertedWith("GS023")
        })

        it('should be able to use EIP-712 for signature generation', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                logGas(
                    "Execute cancel transaction with EIP-712 signature",
                    executeTx(safe, tx, [await safeSignTypedData(user1, safe, tx)])
                )
            ).to.emit(safe, "ExecutionSuccess")
        })

        it('should not be able to use different chainId for signing', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                executeTx(safe, tx, [await safeSignTypedData(user1, safe, tx, 1)])
            ).to.be.revertedWith("GS026")
        })

        it('should be able to use Signed Ethereum Messages for signature generation', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                logGas(
                    "Execute cancel transaction with signed Ethereum message",
                    executeTx(safe, tx, [await safeSignMessage(user1, safe, tx)])
                )
            ).to.emit(safe, "ExecutionSuccess")
        })

        it('msg.sender does not need to approve before', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                logGas(
                    "Without pre approved signature for msg.sender",
                    executeTx(safe, tx, [await safeApproveHash(user1, safe, tx, true)])
                )
            ).to.emit(safe, "ExecutionSuccess")
        })

        it('if not msg.sender on-chain approval is required', async () => {
            const { safe } = await setupTests()
            const user2Safe = safe.connect(user2)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                executeTx(user2Safe, tx, [await safeApproveHash(user1, safe, tx, true)])
            ).to.be.revertedWith("GS025")
        })

        it('should be able to use pre approved hashes for signature generation', async () => {
            const { safe } = await setupTests()
            const user2Safe = safe.connect(user2)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const approveHashSig = await safeApproveHash(user1, safe, tx)
            expect(
                await safe.approvedHashes(user1.address, txHash)
            ).to.be.eq(1)
            await expect(
                logGas(
                    "With pre approved signature",
                    executeTx(user2Safe, tx, [approveHashSig])
                )
            ).to.emit(safe, "ExecutionSuccess")
            // Approved hash should not reset automatically
            expect(
                await safe.approvedHashes(user1.address, txHash)
            ).to.be.eq(1)
        })

        it('should revert if threshold is not set', async () => {
            await setupTests()
            const safe = await getSafeTemplate()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                executeTx(safe, tx, [])
            ).to.be.revertedWith("GS001")
        })

        it('should not be able to use different signature type of same owner', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                executeTx(safe, tx, [await safeApproveHash(user1, safe, tx), await safeSignTypedData(user1, safe, tx), await safeSignTypedData(user3, safe, tx)])
            ).to.be.revertedWith("GS026")
        })

        it('should be able to mix all signature types', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            await expect(
                logGas(
                    "Execute cancel transaction with 4 owners",
                    executeTx(safe, tx, [
                        await safeApproveHash(user1, safe, tx, true),
                        await safeApproveHash(user4, safe, tx),
                        await safeSignTypedData(user2, safe, tx),
                        await safeSignTypedData(user3, safe, tx)
                    ])
                )
            ).to.emit(safe, "ExecutionSuccess")
        })
    })

    describe("checkSignatures", async () => {
        it('should fail if signatures data is not present', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())

            const signatures = "0x" + "000000000000000000000000" + user1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000041" + "00" // r, s, v

            await expect(
                safe.checkSignatures(txHash, txHashData, signatures)
            ).to.be.revertedWith("GS022")
        })

        it('should fail if signatures data is too short', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())

            const signatures = "0x" + "000000000000000000000000" + user1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000041" + "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000020" // length

            await expect(
                safe.checkSignatures(txHash, txHashData, signatures)
            ).to.be.revertedWith("GS023")
        })

        it('should not be able to use different chainId for signing', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([await safeSignTypedData(user1, safe, tx, 1)])
            await expect(
                safe.checkSignatures(txHash, txHashData, signatures)
            ).to.be.revertedWith("GS026")
        })

        it('if not msg.sender on-chain approval is required', async () => {
            const { safe } = await setupTests()
            const user2Safe = safe.connect(user2)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([await safeApproveHash(user1, safe, tx, true)])
            await expect(
                user2Safe.checkSignatures(txHash, txHashData, signatures)
            ).to.be.revertedWith("GS025")
        })

        it('should revert if threshold is not set', async () => {
            await setupTests()
            const safe = await getSafeTemplate()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            await expect(
                safe.checkSignatures(txHash, txHashData, "0x")
            ).to.be.revertedWith("GS001")
        })


        it('should not be able to use different signature type of same owner', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx),
                await safeSignTypedData(user1, safe, tx),
                await safeSignTypedData(user3, safe, tx)
            ])
            await expect(
                safe.checkSignatures(txHash, txHashData, signatures)
            ).to.be.revertedWith("GS026")
        })

        it('should be able to mix all signature types', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx, true),
                await safeApproveHash(user4, safe, tx),
                await safeSignTypedData(user2, safe, tx),
                await safeSignTypedData(user3, safe, tx)
            ])

            await safe.checkSignatures(txHash, txHashData, signatures)
        })
    })

    describe("checkSignatures", async () => {

        it('should fail if signatures data is not present', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())

            const signatures = "0x" + "000000000000000000000000" + user1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000041" + "00" // r, s, v

            await expect(
                safe.checkStakeSignatures(txHash, txHashData, signatures, 1)
            ).to.be.revertedWith("GS022")
        })

        it('should fail if signatures data is too short', async () => {
            const { safe } = await setupTests()
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())

            const signatures = "0x" + "000000000000000000000000" + user1.address.slice(2) + "0000000000000000000000000000000000000000000000000000000000000041" + "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000020" // length

            await expect(
                safe.checkStakeSignatures(txHash, txHashData, signatures, 1)
            ).to.be.revertedWith("GS023")
        })

        it('should not be able to use different chainId for signing', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([await safeSignTypedData(user1, safe, tx, 1)])
            await expect(
                safe.checkStakeSignatures(txHash, txHashData, signatures, 1)
            ).to.be.revertedWith("GS026")
        })

        it('if not msg.sender on-chain approval is required', async () => {
            const { safe } = await setupTests()
            const user2Safe = safe.connect(user2)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([await safeApproveHash(user1, safe, tx, true)])
            await expect(
                user2Safe.checkStakeSignatures(txHash, txHashData, signatures, 1)
            ).to.be.revertedWith("GS025")
        })

        it('should not be able to use different signature type of same owner', async () => {
            const {token} = await setupTests()
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx),
                await safeSignTypedData(user1, safe, tx),
                await safeSignTypedData(user3, safe, tx)
            ])
            await expect(
                safe.checkStakeSignatures(txHash, txHashData, signatures, 3)
            ).to.be.revertedWith("GS026")
        })

        it('should be able to mix all signature types', async () => {
            const { token } = await setupTests()
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address], token.address)
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() })
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId())
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId())
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx, true),
                await safeApproveHash(user4, safe, tx),
                await safeSignTypedData(user2, safe, tx),
                await safeSignTypedData(user3, safe, tx)
            ])

            await safe.checkStakeSignatures(txHash, txHashData, signatures, 3)
        })

    })

    describe('stake check', () => {
        let sContract: Contract;
        let Token: Contract;
        beforeEach(async () => {
            const { token } = await setupTests();
            Token = token;
            sContract = await getSafeWithOwners([user1.address, user2.address, user3.address], token.address, 50)
            await user1.sendTransaction({to: sContract.address, value: parseEther('10')})
            await Token.approve(sContract.address, parseEther('2'))
            await sContract.stake(parseEther('2'))
            await Token.connect(user2).approve(sContract.address, parseEther('1'))
            await sContract.connect(user2).stake(parseEther('1'))
            await Token.connect(user3).approve(sContract.address, parseEther('1'))
            await sContract.connect(user3).stake(parseEther('1'))
        })
        it('should revert if not enough staked balance', async () => {
            const nonce = await sContract.nonce()
            const tx = buildSafeTransaction({ to: user4.address, value: parseEther("1"), nonce })
            await expect(executeTxWithSigners(sContract, tx, [user2])).to.be.revertedWith('revert not enough staked balance')
        });
        it('should exec tx if enough staked balance', async () => {
            const nonce = await sContract.nonce()
            const tx = buildSafeTransaction({ to: user4.address, value: parseEther("1"), nonce })
            const prevBalance = await ethers.provider.getBalance(user4.address);
            await executeTxWithSigners(sContract, tx, [user1]);
            await expect(await ethers.provider.getBalance(user4.address)).to.be.deep.eq(prevBalance.add(parseEther("1")))
        });
    })
})

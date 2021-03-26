import { Initialized as ATokenInitialized } from '../../../generated/templates/AToken/AToken';
import { Initialized as VTokenInitialized } from '../../../generated/templates/VariableDebtToken/VariableDebtToken';
import { Initialized as STokenInitialized } from '../../../generated/templates/StableDebtToken/StableDebtToken';
import { AaveIncentivesController } from '../../../generated/templates';
import { IncentivesController, Reserve } from '../../../generated/schema';
import { Address, log } from '@graphprotocol/graph-ts';
import { IERC20Detailed } from '../../../generated/templates/AToken/IERC20Detailed';
export {
  handleATokenBurn,
  handleATokenMint,
  handleATokenTransfer,
  handleVariableTokenBurn,
  handleVariableTokenMint,
  handleStableTokenMint,
  handleStableTokenBurn,
  handleStableTokenBorrowAllowanceDelegated,
  handleVariableTokenBorrowAllowanceDelegated,
} from './tokenization';

function createIncentivesController(
  incentivesController: Address,
  underlyingAsset: Address,
  pool: Address
): void {
  let iController = IncentivesController.load(incentivesController.toHexString());
  if (!iController) {
    iController = new IncentivesController(incentivesController.toHexString());

    // get incentive reward info
    let AaveIncentivesControllerContract = AaveIncentivesController.bind(incentivesController);
    let rewardToken = AaveIncentivesControllerContract.REWARD_TOKEN();

    let IERC20DetailedContract = IERC20Detailed.bind(rewardToken);
    let rewardTokenDecimals = IERC20DetailedContract.decimals();
    let rewardTokenSymbol = IERC20DetailedContract.symbol();

    iController.rewardToken = rewardToken;
    iController.rewardTokenDecimals = rewardTokenDecimals;
    iController.rewardTokenSymbol = rewardTokenSymbol;

    iController.save();

    AaveIncentivesController.create(incentivesController);
  }

  // reserve
  let reserveId = underlyingAsset.toHexString() + pool.toHexString();
  let reserve = Reserve.load(reserveId);

  if (!reserve) {
    log.error('Error getting the pool. pool: {} | underlying: {}', [
      pool.toHexString(),
      underlyingAsset.toHexString(),
    ]);
    return;
  }

  reserve.incentivesController = iController.id;
  reserve.save();
}

export function handleATokenInitialized(event: ATokenInitialized): void {
  createIncentivesController(
    event.params.incentivesController,
    event.params.underlyingAsset,
    event.params.pool
  );
}

export function handleSTokenInitialized(event: STokenInitialized): void {
  createIncentivesController(
    event.params.incentivesController,
    event.params.underlyingAsset,
    event.params.pool
  );
}

export function handleVTokenInitialized(event: VTokenInitialized): void {
  createIncentivesController(
    event.params.incentivesController,
    event.params.underlyingAsset,
    event.params.pool
  );
}

import { Bytes, Address, log, ethereum } from '@graphprotocol/graph-ts';

import {
  AssetSourceUpdated,
  FallbackOracleUpdated,
  AaveOracle,
  WethSet,
} from '../../generated/AaveOracle/AaveOracle';
import { IExtendedPriceAggregator } from '../../generated/AaveOracle/IExtendedPriceAggregator';
import { GenericOracleI as FallbackPriceOracle } from '../../generated/AaveOracle/GenericOracleI';
import { AggregatorUpdated } from '../../generated/ChainlinkSourcesRegistry/ChainlinkSourcesRegistry';
import {
  ChainlinkAggregator as ChainlinkAggregatorContract,
  FallbackPriceOracle as FallbackPriceOracleContract,
} from '../../generated/templates';
import { convertToLowerCase, namehash } from '../utils/converters';
import {
  getChainlinkAggregator,
  getOrInitPriceOracle,
  getPriceOracleAsset,
  getOrInitENS,
  getOrInitReserve,
} from '../helpers/initializers';
import {
  formatUsdEthChainlinkPrice,
  getPriceOracleAssetType,
  PRICE_ORACLE_ASSET_PLATFORM_UNISWAP,
  PRICE_ORACLE_ASSET_TYPE_SIMPLE,
  zeroAddress,
  zeroBI,
} from '../utils/converters';
import { MOCK_USD_ADDRESS, ZERO_ADDRESS } from '../utils/constants';
import { genericPriceUpdate, usdEthPriceUpdate } from '../helpers/price-updates';
import { PriceOracle, PriceOracleAsset, WETHReserve } from '../../generated/schema';
import { IERC20Detailed } from '../../generated/templates/LendingPoolConfigurator/IERC20Detailed';
import { EACAggregatorProxy } from '../../generated/AaveOracle/EACAggregatorProxy';

export function handleWethSet(event: WethSet): void {
  let wethAddress = event.params.weth;
  let weth = WETHReserve.load('weth');
  if (weth == null) {
    weth = new WETHReserve('weth');
  }
  weth.address = wethAddress;
  weth.name = 'WEthereum';
  weth.symbol = 'WETH';
  weth.decimals = 18;
  weth.updatedTimestamp = event.block.timestamp.toI32();
  weth.updatedBlockNumber = event.block.number;
  weth.save();
}

export function handleFallbackOracleUpdated(event: FallbackOracleUpdated): void {
  let priceOracle = getOrInitPriceOracle();

  priceOracle.fallbackPriceOracle = event.params.fallbackOracle;
  if (event.params.fallbackOracle.toHexString() != ZERO_ADDRESS) {
    FallbackPriceOracleContract.create(event.params.fallbackOracle);

    // update prices on assets which use fallback

    priceOracle.tokensWithFallback.forEach(token => {
      let priceOracleAsset = getPriceOracleAsset(token);
      if (
        priceOracleAsset.priceSource.equals(zeroAddress()) ||
        priceOracleAsset.isFallbackRequired
      ) {
        let proxyPriceProvider = AaveOracle.bind(event.address);
        let price = proxyPriceProvider.try_getAssetPrice(
          Bytes.fromHexString(priceOracleAsset.id) as Address
        );
        if (!price.reverted) {
          genericPriceUpdate(priceOracleAsset, price.value, event);
        } else {
          log.error(
            'OracleAssetId: {} | ProxyPriceProvider: {} | FallbackOracle: {} | EventAddress: {}',
            [
              priceOracleAsset.id,
              event.address.toHexString(),
              event.params.fallbackOracle.toHexString(),
              event.address.toHexString(),
            ]
          );
        }
      }
    });

    // update USDETH price
    let fallbackOracle = FallbackPriceOracle.bind(event.params.fallbackOracle);
    let ethUsdPrice = zeroBI();
    // try method for dev networks
    let ethUsdPriceCall = fallbackOracle.try_getEthUsdPrice();
    if (ethUsdPriceCall.reverted) {
      // try method for ropsten and mainnet
      ethUsdPrice = formatUsdEthChainlinkPrice(
        fallbackOracle.getAssetPrice(Address.fromString(MOCK_USD_ADDRESS))
      );
    } else {
      ethUsdPrice = ethUsdPriceCall.value;
    }
    if (
      priceOracle.usdPriceEthFallbackRequired ||
      priceOracle.usdPriceEthMainSource.equals(zeroAddress())
    ) {
      usdEthPriceUpdate(priceOracle, ethUsdPrice, event);
    }
  }
}

export function priceFeedUpdated(
  event: ethereum.Event,
  assetAddress: Address,
  assetOracleAddress: Address,
  priceOracleAsset: PriceOracleAsset,
  priceOracle: PriceOracle
): void {
  let sAssetAddress = assetAddress.toHexString();

  // We get the current price from the oracle. Valid for chainlink source and custom oracle
  let proxyPriceProvider = AaveOracle.bind(
    Address.fromString(priceOracle.proxyPriceProvider.toHexString())
  );
  let priceFromOracle = zeroBI();
  let priceFromProxyCall = proxyPriceProvider.try_getAssetPrice(assetAddress);
  if (!priceFromProxyCall.reverted) {
    priceFromOracle = priceFromProxyCall.value;
  } else {
    log.error(`this asset has not been registered. || asset: {} | assetOracle: {}`, [
      sAssetAddress,
      assetOracleAddress.toHexString(),
    ]);
    return;
  }

  priceOracleAsset.isFallbackRequired = true;

  // if it's valid oracle address
  if (!assetOracleAddress.equals(zeroAddress())) {
    let priceAggregatorInstance = IExtendedPriceAggregator.bind(assetOracleAddress);

    // check is it composite or simple asset.
    // In case its chainlink source, this call will revert, and will not update priceOracleAsset type
    // so it will stay as simple, as it is the default type
    let tokenTypeCall = priceAggregatorInstance.try_getTokenType();
    if (!tokenTypeCall.reverted) {
      priceOracleAsset.type = getPriceOracleAssetType(tokenTypeCall.value);
    }

    // Type simple means that the source is chainlink source
    if (priceOracleAsset.type == PRICE_ORACLE_ASSET_TYPE_SIMPLE) {
      // get underlying aggregator from proxy (assetOracleAddress) address
      let chainlinkProxyInstance = EACAggregatorProxy.bind(assetOracleAddress);
      let aggregatorAddressCall = chainlinkProxyInstance.try_aggregator();
      // If we can't get the aggregator, it means that the source address is not a chainlink proxy
      // so it has been registered badly.
      if (aggregatorAddressCall.reverted) {
        log.error(`Simple Type must be a chainlink proxy. || asset: {} | assetOracleAddress: {}`, [
          sAssetAddress,
          assetOracleAddress.toHexString(),
        ]);
        return;
      }
      let aggregatorAddress = aggregatorAddressCall.value;
      priceOracleAsset.priceSource = aggregatorAddress;
      // create ChainLink aggregator template entity
      ChainlinkAggregatorContract.create(aggregatorAddress);

      // Register the aggregator address to the ens registry
      // we can get the reserve as aave oracle is in the contractToPoolMapping as proxyPriceProvider
      let reserve = getOrInitReserve(assetAddress, event);
      let aToken = reserve.aToken;
      let ERC20ATokenContract = IERC20Detailed.bind(Bytes.fromHexString(aToken) as Address);
      // TODO: not entirely sure if this solution will be useful for all the cases!!!!
      let symbol = ERC20ATokenContract.symbol().slice(1); // TODO: remove slice if we change

      // Hash the ENS to generate the node and create the ENS register in the schema.
      if (
        convertToLowerCase(assetAddress.toHexString()) ==
        '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2'
      ) {
        symbol = 'MKR';
      } else {
        // we need to use the underlying, as the anchor address is not mapped to the lending pool
        let ERC20ATokenContract = IERC20Detailed.bind(assetAddress);
        symbol = ERC20ATokenContract.symbol().slice(1); // TODO: remove slice if we change
      }

      let domain: Array<string> = [
        'aggregator',
        convertToLowerCase(symbol) + '-eth',
        'data',
        'eth',
      ];

      // Hash the ENS to generate the node and create the ENS register in the schema.
      let node = namehash(domain);

      log.warning(`Proxy node construction is ::: {}`, [node]);

      // Create the ENS or update
      let ens = getOrInitENS(node);
      ens.aggregatorAddress = aggregatorAddress;
      ens.underlyingAddress = assetAddress;
      ens.symbol = symbol;
      ens.save();

      // Need to check latestAnswer and not use priceFromOracle because priceFromOracle comes from the oracle
      // and the value could be from the fallback already. So we need to check if we can get latestAnswer from the
      // chainlink aggregator
      let priceAggregatorlatestAnswerCall = priceAggregatorInstance.try_latestAnswer();
      priceOracleAsset.isFallbackRequired =
        priceAggregatorlatestAnswerCall.reverted || priceAggregatorlatestAnswerCall.value.isZero();

      // create chainlinkAggregator entity with new aggregator to be able to match asset and oracle after
      let chainlinkAggregator = getChainlinkAggregator(aggregatorAddress.toHexString());
      chainlinkAggregator.oracleAsset = assetAddress.toHexString();
      chainlinkAggregator.save();
    } else {
      // composite assets don't need fallback, it will work out of the box
      priceOracleAsset.isFallbackRequired = false;
      priceOracleAsset.priceSource = assetOracleAddress;

      // call contract and check on which assets we're dependent
      let dependencies = priceAggregatorInstance.getSubTokens();
      // add asset to all dependencies
      for (let i = 0; i < dependencies.length; i += 1) {
        let dependencyAddress = dependencies[i].toHexString();
        if (dependencyAddress == MOCK_USD_ADDRESS) {
          let usdDependentAssets = priceOracle.usdDependentAssets;
          if (!usdDependentAssets.includes(sAssetAddress)) {
            usdDependentAssets.push(sAssetAddress);
            priceOracle.usdDependentAssets = usdDependentAssets;
          }
        } else {
          let dependencyOracleAsset = getPriceOracleAsset(dependencyAddress);
          let dependentAssets = dependencyOracleAsset.dependentAssets;
          if (!dependentAssets.includes(sAssetAddress)) {
            dependentAssets.push(sAssetAddress);
            dependencyOracleAsset.dependentAssets = dependentAssets;
            dependencyOracleAsset.save();
          }
        }
      }
    }

    if (sAssetAddress == MOCK_USD_ADDRESS) {
      priceOracle.usdPriceEthFallbackRequired = priceOracleAsset.isFallbackRequired;
      priceOracle.usdPriceEthMainSource = priceOracleAsset.priceSource;
      usdEthPriceUpdate(priceOracle, formatUsdEthChainlinkPrice(priceFromOracle), event);
    } else {
      // if chainlink was invalid before and valid now, remove from tokensWithFallback array
      if (
        !assetOracleAddress.equals(zeroAddress()) &&
        priceOracle.tokensWithFallback.includes(sAssetAddress) &&
        !priceOracleAsset.isFallbackRequired
      ) {
        priceOracle.tokensWithFallback = priceOracle.tokensWithFallback.filter(
          token => token != assetAddress.toHexString()
        );
      }

      if (
        !priceOracle.tokensWithFallback.includes(sAssetAddress) &&
        (assetOracleAddress.equals(zeroAddress()) || priceOracleAsset.isFallbackRequired)
      ) {
        let updatedTokensWithFallback = priceOracle.tokensWithFallback;
        updatedTokensWithFallback.push(sAssetAddress);
        priceOracle.tokensWithFallback = updatedTokensWithFallback;
      }
      priceOracle.save();

      genericPriceUpdate(priceOracleAsset, priceFromOracle, event);
    }
  }
}

export function handleChainlinkAggregatorUpdated(event: AggregatorUpdated): void {
  let assetAddress = event.params.token;
  let assetOracleAddress = event.params.aggregator;

  let priceOracle = getOrInitPriceOracle();
  let priceOracleAsset = getPriceOracleAsset(assetAddress.toHexString());
  priceOracleAsset.fromChainlinkSourcesRegistry = true;
  if (priceOracle.version == 1) {
    chainLinkAggregatorUpdated(
      event,
      assetAddress,
      assetOracleAddress,
      priceOracleAsset,
      priceOracle
    );
  } else {
    log.error(
      `Event should not have been called for version > 1 || asset: {} | oracleAddress: {}`,
      [assetAddress.toHexString(), assetOracleAddress.toHexString()]
    );
  }
}

export function handleAssetSourceUpdated(event: AssetSourceUpdated): void {
  let assetAddress = event.params.asset;
  let sAssetAddress = assetAddress.toHexString();
  let assetOracleAddress = event.params.source;
  // because of the bug with wrong assets addresses submission
  if (sAssetAddress.split('0').length > 38) {
    log.warning('skipping wrong asset registration {}', [sAssetAddress]);
    return;
  }
  let priceOracle = getOrInitPriceOracle();
  if (priceOracle.proxyPriceProvider.equals(zeroAddress())) {
    priceOracle.proxyPriceProvider = event.address;
  }

  let priceOracleAsset = getPriceOracleAsset(assetAddress.toHexString());

  if (priceOracle.version > 1) {
    priceFeedUpdated(event, assetAddress, assetOracleAddress, priceOracleAsset, priceOracle);
  } else {
    if (!priceOracleAsset.fromChainlinkSourcesRegistry) {
      chainLinkAggregatorUpdated(
        event,
        assetAddress,
        assetOracleAddress,
        priceOracleAsset,
        priceOracle
      );
    }
  }
}

function chainLinkAggregatorUpdated(
  event: ethereum.Event,
  assetAddress: Address,
  assetOracleAddress: Address,
  priceOracleAsset: PriceOracleAsset,
  priceOracle: PriceOracle
): void {
  let sAssetAddress = assetAddress.toHexString();

  let proxyPriceProvider = AaveOracle.bind(
    Address.fromString(priceOracle.proxyPriceProvider.toHexString())
  );

  //needed because of one wrong handleAssetSourceUpdated event deployed on the mainnet
  let priceFromProxy = zeroBI();

  let priceFromProxyCall = proxyPriceProvider.try_getAssetPrice(assetAddress);

  if (!priceFromProxyCall.reverted) {
    priceFromProxy = priceFromProxyCall.value;
  }

  priceOracleAsset.isFallbackRequired = true;

  // if it's valid oracle address
  if (!assetOracleAddress.equals(zeroAddress())) {
    let priceAggregatorInstance = IExtendedPriceAggregator.bind(assetOracleAddress);

    // // check is it composite or simple asset
    let tokenTypeCall = priceAggregatorInstance.try_getTokenType();
    if (!tokenTypeCall.reverted) {
      priceOracleAsset.type = getPriceOracleAssetType(tokenTypeCall.value);
    }

    if (priceOracleAsset.type == PRICE_ORACLE_ASSET_TYPE_SIMPLE) {
      // create ChainLink aggregator template entity
      // ChainlinkAggregatorContract.create(assetOracleAddress);

      // fallback is not required if oracle works fine
      let priceAggregatorlatestAnswerCall = priceAggregatorInstance.try_latestAnswer();
      priceOracleAsset.isFallbackRequired =
        priceAggregatorlatestAnswerCall.reverted || priceAggregatorlatestAnswerCall.value.isZero();
    } else {
      // composite assets don't need fallback, it will work out of the box
      priceOracleAsset.isFallbackRequired = false;

      // call contract and check on which assets we're dependent
      let dependencies = priceAggregatorInstance.getSubTokens();
      // add asset to all dependencies
      for (let i = 0; i < dependencies.length; i += 1) {
        let dependencyAddress = dependencies[i].toHexString();
        if (dependencyAddress == MOCK_USD_ADDRESS) {
          let usdDependentAssets = priceOracle.usdDependentAssets;
          if (!usdDependentAssets.includes(sAssetAddress)) {
            usdDependentAssets.push(sAssetAddress);
            priceOracle.usdDependentAssets = usdDependentAssets;
          }
        } else {
          let dependencyOracleAsset = getPriceOracleAsset(dependencyAddress);
          let dependentAssets = dependencyOracleAsset.dependentAssets;
          if (!dependentAssets.includes(sAssetAddress)) {
            dependentAssets.push(sAssetAddress);
            dependencyOracleAsset.dependentAssets = dependentAssets;
            dependencyOracleAsset.save();
          }
        }
      }
      // if it's first oracle connected to this asset
      // commented until uniswap
      // if (priceOracleAsset.priceSource.equals(zeroAddress())) {
      //   // start listening on the platform updates
      //   if (priceOracleAsset.platform === PRICE_ORACLE_ASSET_PLATFORM_UNISWAP) {
      //     UniswapExchangeContract.create(assetAddress);
      //   }
      // }
    }

    // add entity to be able to match asset and oracle after
    let chainlinkAggregator = getChainlinkAggregator(assetOracleAddress.toHexString());
    chainlinkAggregator.oracleAsset = sAssetAddress;
    chainlinkAggregator.save();
  }
  // set price aggregator address
  priceOracleAsset.priceSource = assetOracleAddress;

  if (sAssetAddress == MOCK_USD_ADDRESS) {
    priceOracle.usdPriceEthFallbackRequired = priceOracleAsset.isFallbackRequired;
    priceOracle.usdPriceEthMainSource = assetOracleAddress;
    usdEthPriceUpdate(priceOracle, formatUsdEthChainlinkPrice(priceFromProxy), event);
  } else {
    // TODO: remove old one ChainLink aggregator template entity if it exists, and it's not fallback oracle
    // if chainlink was invalid before and valid now, remove from tokensWithFallback array
    if (
      !assetOracleAddress.equals(zeroAddress()) &&
      priceOracle.tokensWithFallback.includes(sAssetAddress) &&
      !priceOracleAsset.isFallbackRequired
    ) {
      priceOracle.tokensWithFallback = priceOracle.tokensWithFallback.filter(
        token => token != assetAddress.toHexString()
      );
    }

    if (
      !priceOracle.tokensWithFallback.includes(sAssetAddress) &&
      (assetOracleAddress.equals(zeroAddress()) || priceOracleAsset.isFallbackRequired)
    ) {
      let updatedTokensWithFallback = priceOracle.tokensWithFallback;
      updatedTokensWithFallback.push(sAssetAddress);
      priceOracle.tokensWithFallback = updatedTokensWithFallback;
    }
    priceOracle.save();

    genericPriceUpdate(priceOracleAsset, priceFromProxy, event);
  }
}

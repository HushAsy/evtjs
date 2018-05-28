const ecc = require('eosjs-ecc');
const { signHash, verifyHash } = ecc;
const AbiCache = require('./abi-cache');
const AssetCache = require('./asset-cache');
const EvtConfig = require("./evtConfig");
const { fetch } = require("./fetch");
const ByteBuffer = require('bytebuffer')

/**
 * APICaller for everiToken
*/
class APICaller {
    /**
     * Creates a new APICaller.
     * @param {EvtConfig} config 
     */
    constructor(config) {
        config = config || new EvtConfig();
        if (typeof config == 'object' && config != null && !(config instanceof EvtConfig)) {
            config = new EvtConfig(config);
        }

        /** @member {EvtConfig} evtConfig */
        this.config = config || new EvtConfig();

        if (!this.config.signProvider) {
            this.config.signProvider = defaultSignProvider(this, this.config);
        }

        // var buffer = new Buffer(32).fill(0, 0, 32);
        // this.config.signProvider({sign: signHash, buf: buffer, transaction: {}});
    }

    /**
     * Call everiToken APIs directly, not suggested to use by user
     * @param {*} request 
     */
    async __callAPI(request) {
        var url = this.config.endpoint.protocol + "://" + this.config.endpoint.host + ":" + this.config.endpoint.port + request.url;

        var res = await fetch(url, {
            method: request.method,
            body: request.body ? JSON.stringify(request.body) : undefined,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        return (await res.json());
    }

    /**
     * get information from everiToken chain node
     */
    async getInfo() {
        var info = await this.__callAPI({
            url: "/v1/chain/get_info",
            method: "GET"
        });

        this.__cachedInfo = info;

        return info;
    }

    /**
     * push transaction to everiToken chain
     */
    async pushTransaction(args) {
        var newDomainName = 'sdf';

        args = JSON.parse(JSON.stringify(args));
        // make sure that it there is basic information about the chain
        if (!this.__cachedInfo) {
            await this.getInfo();
        }

        // TODO version check

        for (let i = 0; i < args.transaction.actions.length; ++i) {
            let originalAction = args.transaction.actions[i];

            // create binary action for push_transaction
            let binAction = {
                name: originalAction.action,
                data: (await this.__chainAbiJsonToBin(originalAction)).binargs
            };

            // use mapper to determine the `domain` and `key` field
            domainKeyMappers[originalAction.action](originalAction, binAction);

            // override action
            args.transaction.actions[i] = binAction;
        }

        // fill extra fields for trx
        let expiration = (new Date(new Date().valueOf() + 100000)).toISOString().substr(0, 19);
        var hash = ByteBuffer.fromHex(this.__cachedInfo.last_irreversible_block_id, true); // little endian
        var numHex = this.__cachedInfo.last_irreversible_block_id.substr(4, 4);
        var last_irreversible_block_num = ByteBuffer.fromHex(numHex, false).readUint16(0);
        var last_irreversible_block_prefix = hash.readUInt32(8);

        args = Object.assign(args, {
            compression: 'none'
        });

        args.transaction = Object.assign(args.transaction, {
            "expiration": expiration,
            "ref_block_num": last_irreversible_block_num,
            "ref_block_prefix": last_irreversible_block_prefix,
            "delay_sec": 0,
        });

        // get digest of the whole trx
        let digestRes = (await this.__getDigestToSign(args.transaction)).digest;

        // sign
        const signBuf = new Buffer(digestRes, 'hex');
        let sigs = await this.__signTransaction(signBuf, args.transaction);

        if (!Array.isArray(sigs)) {
            sigs = [ sigs ]
        }
        
        args.signatures = sigs;

        // push transaction
        var res = await this.__chainPushTransaction(args);

        // check if it is successful
        if (res && res.processed && res.processed.receipt && res.processed.receipt.status === 'executed') {
            return true;
        }
        else {
            // throw error detail
            if (res && res.error && res.error.details && res.error.details.length) {
                throw new Error(res.error.what + " (" + res.error.code + "): " + res.error.details.map(r => r.message ? (r.message + "; "): ""));
            }
            else {
                throw new Error("did not receive anything from the chain");
            }
        }
    }
    
    __chainAbiJsonToBin(abi) {
        return this.__callAPI({
            url: "/v1/chain/abi_json_to_bin",
            method: "POST",
            body: abi
        });
    }

    __signTransaction(buf, transaction) {
        return this.config.signProvider({signHash, buf, transaction});
    }

    __getDigestToSign(transaction) {
        return this.__callAPI({
            url: "/v1/chain/trx_json_to_digest",
            method: "POST",
            body: transaction
        });
    }

    __chainPushTransaction(tr) {
        return this.__callAPI({
            url: "/v1/chain/push_transaction",
            method: "POST",
            body: tr
        });
    }

    __chainGetRequiredKeys(tr) {
        return this.__callAPI({
            url: "/v1/chain/get_required_keys",
            method: "POST",
            body: tr
        });
    }
}

const domainKeyMappers = {
    'newdomain': (action, transfered) => {
        transfered.domain = "domain";
        transfered.key = action.args.name;
    },

    'issuetoken': (action, transfered) => {
        transfered.domain = action.args.domain;
        transfered.key = "issue";
    },

    'newgroup': (action, transfered) => {
        transfered.domain = 'group';
        transfered.key = action.args.name;
    }
};

/**
  The default sign provider is designed to interact with the available public
  keys (maybe just one), the transaction, and the blockchain to figure out
  the minimum set of signing keys.

  If only one key is available, the blockchain API calls are skipped and that
  key is used to sign the transaction.
*/
const defaultSignProvider = (apiCaller, config) => async function ({ sign, buf, transaction }) {
    const { keyProvider } = config

    if (!keyProvider) {
        throw new TypeError('This transaction requires a config.keyProvider for signing')
    }

    let keys = keyProvider
    if (typeof keyProvider === 'function') {
        keys = keyProvider({ transaction })
    }

    // keyProvider may return keys or Promise<keys>
    keys = await Promise.resolve(keys)

    if (!Array.isArray(keys)) {
        keys = [keys]
    }

    keys = keys.map(key => {
        try {
            // normalize format (WIF => PVT_K1_base58privateKey)
            return { private: ecc.PrivateKey(key).toString() }
        } catch (e) {
            // normalize format (EOSKey => PUB_K1_base58publicKey)
            return { public: ecc.PublicKey(key).toString() }
        }
        assert(false, 'expecting public or private keys from keyProvider')
    })

    if (!keys.length) {
        throw new Error('missing key, check your keyProvider')
    }

    // simplify default signing #17
    if (keys.length === 1 && keys[0].private) {
        const pvt = keys[0].private
        var ret = signHash(buf, pvt)
        
        return ret;
    }

    const keyMap = new Map()

    // keys are either public or private keys
    for (const key of keys) {
        const isPrivate = key.private != null
        const isPublic = key.public != null

        if (isPrivate) {
            keyMap.set(ecc.privateToPublic(key.private), key.private)
        } else {
            keyMap.set(key.public, null)
        }
    }

    const pubkeys = Array.from(keyMap.keys())

    // TODO: add multiple signature support

    /*return eos.getRequiredKeys(transaction, pubkeys).then(({ required_keys }) => {
        if (!required_keys.length) {
            throw new Error('missing required keys for ' + JSON.stringify(transaction))
        }*/

        const pvts = [], missingKeys = []

        required_keys = pubkeys[0]; // assume that we need only the first key, will be changed in the future TODO

        for (let requiredKey of required_keys) {
            // normalize (EOSKey.. => PUB_K1_Key..)
            requiredKey = ecc.PublicKey(requiredKey).toString()

            const wif = keyMap.get(requiredKey)
            if (wif) {
                pvts.push(wif)
            } else {
                missingKeys.push(requiredKey)
            }
        }

        if (missingKeys.length !== 0) {
            assert(typeof keyProvider === 'function',
                'keyProvider function is needed for private key lookup')

            // const pubkeys = missingKeys.map(key => ecc.PublicKey(key).toStringLegacy())
            keyProvider({ pubkeys: missingKeys })
                .forEach(pvt => { pvts.push(pvt) })
        }

        const sigs = []
        for (const pvt of pvts) {
            sigs.push(signHash(buf, pvt))
        }

        return sigs
    //})
}

module.exports = { APICaller };

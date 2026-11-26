//! The Merkle tree of an allowlist: how a list of addresses becomes one 32-byte root, and how a
//! proof shows that one address is on the list.
//!
//! The code comes from the airdrop project (`../airdrop/src/merkle.rs`), with one change: a leaf
//! holds an address and no amount, because everyone on an allowlist may buy up to the same limit.
//!
//! The web app builds the same tree in `web/src/merkle.ts`; `resources/merkle_vector.json`, which
//! that code writes, pins the two together (see the tests below).
//!
//! - A **leaf** is `blake2b256(0x00 ‖ address)`: the address as the contract serializes it (a tag
//!   byte, `0x00` for an account hash or `0x01` for a contract package hash, then its 32 bytes).
//!   34 bytes are hashed.
//! - A **node** is `blake2b256(0x01 ‖ min(a, b) ‖ max(a, b))`, where `a` and `b` are its two
//!   children compared as byte strings. Sorting the pair means a proof needs no left/right bits.
//! - The leaves are taken in the order of the list. Each level pairs its nodes in order, the first
//!   with the second, the third with the fourth; a last node without a partner moves up unchanged.
//!   The root is the one node left. A list of one address has its leaf as the root.
//! - The proof of an address is the partner of its node on each level, from the leaves up,
//!   skipping the levels where it has none. The contract takes it as one byte string of 32-byte
//!   nodes.
//!
//! The two prefixes keep a leaf from ever being read as a node (34 bytes against 65 hashed).

use odra::prelude::*;

/// The first byte hashed into a leaf.
pub const LEAF_PREFIX: u8 = 0x00;
/// The first byte hashed into a node.
pub const NODE_PREFIX: u8 = 0x01;
/// The length of a hash, of a root and of each node of a proof.
pub const HASH_LENGTH: usize = 32;

/// The bytes hashed into the leaf of `buyer`: 34 bytes.
pub fn leaf_preimage(buyer: &Address) -> [u8; 34] {
    let mut bytes = [0u8; 34];
    bytes[0] = LEAF_PREFIX;
    // The same bytes as `Address::to_bytes`: the tag of the `Key` and the 32 bytes of the hash.
    let (tag, hash) = match buyer {
        Address::Account(account_hash) => (0u8, account_hash.value()),
        Address::Contract(package_hash) => (1u8, package_hash.value()),
    };
    bytes[1] = tag;
    bytes[2..34].copy_from_slice(&hash);
    bytes
}

/// The bytes hashed into the parent of two nodes: the prefix, then the smaller node first.
pub fn node_preimage(a: &[u8; HASH_LENGTH], b: &[u8; HASH_LENGTH]) -> [u8; 65] {
    let (first, second) = if a <= b { (a, b) } else { (b, a) };
    let mut bytes = [0u8; 65];
    bytes[0] = NODE_PREFIX;
    bytes[1..33].copy_from_slice(first);
    bytes[33..65].copy_from_slice(second);
    bytes
}

#[cfg(not(target_arch = "wasm32"))]
pub use tree::*;

/// Builds trees off-chain, for the tests and the command line tool. The contract only verifies.
#[cfg(not(target_arch = "wasm32"))]
mod tree {
    use super::*;
    use blake2::digest::{Update, VariableOutput};
    use blake2::Blake2bVar;
    use odra::casper_types::bytesrepr::Bytes;

    /// blake2b with a 32-byte output and no key: what `ContractEnv::hash` computes on Casper.
    pub fn blake2b256(data: &[u8]) -> [u8; HASH_LENGTH] {
        let mut hasher = Blake2bVar::new(HASH_LENGTH).expect("32 is a valid blake2b length");
        hasher.update(data);
        let mut result = [0u8; HASH_LENGTH];
        hasher
            .finalize_variable(&mut result)
            .expect("the output has the requested length");
        result
    }

    /// The leaf of one address of the list.
    pub fn leaf(buyer: &Address) -> [u8; HASH_LENGTH] {
        blake2b256(&leaf_preimage(buyer))
    }

    /// The Merkle tree of an allowlist.
    pub struct Tree {
        /// The levels from the leaves (first) to the root (last, one node).
        levels: Vec<Vec<[u8; HASH_LENGTH]>>,
    }

    impl Tree {
        /// Builds the tree of `list`, in its order. Panics on an empty list.
        pub fn new(list: &[Address]) -> Self {
            assert!(!list.is_empty(), "a tree needs at least one leaf");
            let mut levels = vec![list.iter().map(leaf).collect::<Vec<_>>()];
            while levels.last().map_or(0, Vec::len) > 1 {
                let next = levels
                    .last()
                    .expect("there is a level")
                    .chunks(2)
                    .map(|pair| match pair {
                        [a, b] => blake2b256(&node_preimage(a, b)),
                        [single] => *single,
                        _ => unreachable!("chunks of two"),
                    })
                    .collect();
                levels.push(next);
            }
            Self { levels }
        }

        /// The root: the one hash a sale stores.
        pub fn root(&self) -> [u8; HASH_LENGTH] {
            self.levels.last().expect("a tree has a root")[0]
        }

        /// The root as `create_sale` takes it.
        pub fn root_bytes(&self) -> Bytes {
            Bytes::from(self.root().to_vec())
        }

        /// The proof of the address at `index`: its partner on each level that has one.
        pub fn proof(&self, index: usize) -> Vec<[u8; HASH_LENGTH]> {
            let mut proof = Vec::new();
            let mut position = index;
            for level in &self.levels[..self.levels.len() - 1] {
                if let Some(partner) = level.get(position ^ 1) {
                    proof.push(*partner);
                }
                position /= 2;
            }
            proof
        }

        /// The proof of the address at `index` as `buy` takes it: the nodes one after another.
        pub fn proof_bytes(&self, index: usize) -> Bytes {
            Bytes::from(self.proof(index).concat())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::casper_types::bytesrepr::ToBytes;
    use std::str::FromStr;

    #[test]
    fn the_leaf_takes_the_address_as_the_contract_serializes_it() {
        let account = Address::from_str(
            "account-hash-0101010101010101010101010101010101010101010101010101010101010101",
        )
        .unwrap();
        let package = Address::from_str(
            "hash-0202020202020202020202020202020202020202020202020202020202020202",
        )
        .unwrap();
        for address in [account, package] {
            let preimage = leaf_preimage(&address);
            assert_eq!(preimage[0], LEAF_PREFIX);
            assert_eq!(&preimage[1..], address.to_bytes().unwrap().as_slice());
        }
        assert_eq!(leaf_preimage(&account)[1], 0);
        assert_eq!(leaf_preimage(&package)[1], 1);
    }

    #[test]
    fn a_node_does_not_depend_on_the_order_of_its_children() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        assert_eq!(node_preimage(&a, &b), node_preimage(&b, &a));
        assert_eq!(node_preimage(&a, &b)[0], NODE_PREFIX);
        assert_eq!(&node_preimage(&b, &a)[1..33], &a);
    }

    #[test]
    fn blake2b_matches_the_reference() {
        // blake2b-256 of the empty string, from the reference implementation.
        assert_eq!(
            hex(&blake2b256(b"")),
            "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
        );
    }

    #[test]
    fn every_proof_leads_to_the_root() {
        for size in 1..=9u64 {
            let list: Vec<Address> = (0..size)
                .map(|i| Address::from_str(&format!("account-hash-{:064x}", i + 1)).unwrap())
                .collect();
            let tree = Tree::new(&list);
            for (index, buyer) in list.iter().enumerate() {
                let node = tree.proof(index).iter().fold(leaf(buyer), |node, partner| {
                    blake2b256(&node_preimage(&node, partner))
                });
                assert_eq!(node, tree.root(), "list of {size}, address {index}");
            }
        }
    }

    /// `resources/merkle_vector.json` is written by `npm run vector` in `web/`, with the tree code
    /// of the web app. The Rust tree must give the same leaves, proofs and root.
    #[test]
    fn the_tree_of_the_web_app_is_the_same() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../resources/merkle_vector.json")).unwrap();
        let list: Vec<Address> = vector["list"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| Address::from_str(entry["address"].as_str().unwrap()).unwrap())
            .collect();
        let tree = Tree::new(&list);
        for (index, buyer) in list.iter().enumerate() {
            let entry = &vector["list"][index];
            assert_eq!(hex(&leaf(buyer)), entry["leaf"].as_str().unwrap());
            let proof: Vec<String> = tree.proof(index).iter().map(|node| hex(node)).collect();
            let expected: Vec<String> = entry["proof"]
                .as_array()
                .unwrap()
                .iter()
                .map(|node| node.as_str().unwrap().to_string())
                .collect();
            assert_eq!(proof, expected, "proof of address {index}");
        }
        assert_eq!(hex(&tree.root()), vector["root"].as_str().unwrap());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

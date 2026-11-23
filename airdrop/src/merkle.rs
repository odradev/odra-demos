//! The Merkle tree of a drop: how a list of recipients and amounts becomes one 32-byte root, and
//! how a proof shows that one entry is on the list.
//!
//! The web app builds the same tree in `web/src/merkle.ts`; `resources/merkle_vector.json`, which
//! that code writes, pins the two together (see the tests below).
//!
//! - A **leaf** is `blake2b256(0x00 ‖ address ‖ amount)`: the address as the contract serializes
//!   it (a tag byte, `0x00` for an account hash or `0x01` for a contract package hash, then its 32
//!   bytes) and the amount as 32 bytes, big-endian. 66 bytes are hashed.
//! - A **node** is `blake2b256(0x01 ‖ min(a, b) ‖ max(a, b))`, where `a` and `b` are its two
//!   children compared as byte strings. Sorting the pair means a proof needs no left/right bits.
//! - The leaves are taken in the order of the list. Each level pairs its nodes in order, the first
//!   with the second, the third with the fourth; a last node without a partner moves up unchanged.
//!   The root is the one node left. A list of one entry has its leaf as the root.
//! - The proof of an entry is the partner of its node on each level, from the leaves up, skipping
//!   the levels where it has none. The contract takes it as one byte string of 32-byte nodes.
//!
//! The two prefixes keep a leaf from ever being read as a node (66 bytes against 65 hashed).

use odra::casper_types::U256;
use odra::prelude::*;

/// The first byte hashed into a leaf.
pub const LEAF_PREFIX: u8 = 0x00;
/// The first byte hashed into a node.
pub const NODE_PREFIX: u8 = 0x01;
/// The length of a hash, of a root and of each node of a proof.
pub const HASH_LENGTH: usize = 32;

/// The bytes hashed into the leaf of `recipient` and `amount`: 66 bytes.
pub fn leaf_preimage(recipient: &Address, amount: &U256) -> [u8; 66] {
    let mut bytes = [0u8; 66];
    bytes[0] = LEAF_PREFIX;
    // The same bytes as `Address::to_bytes`: the tag of the `Key` and the 32 bytes of the hash.
    let (tag, hash) = match recipient {
        Address::Account(account_hash) => (0u8, account_hash.value()),
        Address::Contract(package_hash) => (1u8, package_hash.value()),
    };
    bytes[1] = tag;
    bytes[2..34].copy_from_slice(&hash);
    amount.to_big_endian(&mut bytes[34..66]);
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

    /// The leaf of one entry of the list.
    pub fn leaf(recipient: &Address, amount: &U256) -> [u8; HASH_LENGTH] {
        blake2b256(&leaf_preimage(recipient, amount))
    }

    /// The Merkle tree of a list of recipients and amounts.
    pub struct Tree {
        /// The levels from the leaves (first) to the root (last, one node).
        levels: Vec<Vec<[u8; HASH_LENGTH]>>,
    }

    impl Tree {
        /// Builds the tree of `list`, in its order. Panics on an empty list.
        pub fn new(list: &[(Address, U256)]) -> Self {
            assert!(!list.is_empty(), "a tree needs at least one leaf");
            let mut levels = vec![list
                .iter()
                .map(|(recipient, amount)| leaf(recipient, amount))
                .collect::<Vec<_>>()];
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

        /// The root: the one hash a drop stores.
        pub fn root(&self) -> [u8; HASH_LENGTH] {
            self.levels.last().expect("a tree has a root")[0]
        }

        /// The proof of the entry at `index`: its partner on each level that has one.
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

        /// The proof of the entry at `index` as the contract takes it: the nodes one after another.
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
            let preimage = leaf_preimage(&address, &U256::from(258));
            assert_eq!(&preimage[1..34], address.to_bytes().unwrap().as_slice());
            assert_eq!(preimage[0], LEAF_PREFIX);
            assert_eq!(&preimage[34..64], &[0u8; 30]);
            assert_eq!(&preimage[64..], &[1, 2]);
        }
        assert_eq!(leaf_preimage(&account, &U256::zero())[1], 0);
        assert_eq!(leaf_preimage(&package, &U256::zero())[1], 1);
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
            let list: Vec<(Address, U256)> = (0..size)
                .map(|i| {
                    let hex = format!("{:064x}", i + 1);
                    (
                        Address::from_str(&format!("account-hash-{hex}")).unwrap(),
                        U256::from(i * 10 + 1),
                    )
                })
                .collect();
            let tree = Tree::new(&list);
            for (index, (recipient, amount)) in list.iter().enumerate() {
                let node = tree
                    .proof(index)
                    .iter()
                    .fold(leaf(recipient, amount), |node, partner| {
                        blake2b256(&node_preimage(&node, partner))
                    });
                assert_eq!(node, tree.root(), "list of {size}, entry {index}");
            }
        }
    }

    /// `resources/merkle_vector.json` is written by `npm run vector` in `web/`, with the tree code
    /// of the web app. The Rust tree must give the same leaves and root.
    #[test]
    fn the_tree_of_the_web_app_is_the_same() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../resources/merkle_vector.json")).unwrap();
        let list: Vec<(Address, U256)> = vector["list"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    Address::from_str(entry["address"].as_str().unwrap()).unwrap(),
                    U256::from_dec_str(entry["amount"].as_str().unwrap()).unwrap(),
                )
            })
            .collect();
        let tree = Tree::new(&list);
        for (index, (recipient, amount)) in list.iter().enumerate() {
            let entry = &vector["list"][index];
            assert_eq!(
                hex(&leaf(recipient, amount)),
                entry["leaf"].as_str().unwrap()
            );
            let proof: Vec<String> = tree.proof(index).iter().map(|node| hex(node)).collect();
            let expected: Vec<String> = entry["proof"]
                .as_array()
                .unwrap()
                .iter()
                .map(|node| node.as_str().unwrap().to_string())
                .collect();
            assert_eq!(proof, expected, "proof of entry {index}");
        }
        assert_eq!(hex(&tree.root()), vector["root"].as_str().unwrap());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

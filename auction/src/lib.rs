#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
extern crate alloc;

pub mod auction;
#[cfg(not(target_arch = "wasm32"))]
pub mod demo;
pub mod nft;

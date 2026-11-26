#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
extern crate alloc;

#[cfg(not(target_arch = "wasm32"))]
pub mod demo;
pub mod swap;
pub mod token;
